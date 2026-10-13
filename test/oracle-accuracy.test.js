import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RULE,gradeOracle,summarizeOracle,createOracleAccuracy} from '../src/oracle/accuracy.js';
import {METHOD} from '../src/oracle/symbols.js';
const date='2026-09-21', pre=Date.parse(`${date}T12:00Z`), close=Date.parse(`${date}T20:15Z`);
const snapshot={date,method:METHOD,rule:RULE,recordedAt:new Date(pre).toISOString()};
const history=(open=100,end=102,day=date)=>({ok:true,source:'test',bars:[{date:day,open,close:end,high:Math.max(open,end),low:Math.min(open,end)}]});
const pack={date,method:METHOD,rows:[{symbol:'UP',direction:'up',seed:'a'},{symbol:'DOWN',direction:'down',seed:'b'},{symbol:'FLAT',direction:'up',seed:'c'},{symbol:'WAIT',direction:'neutral',seed:'d'}]};

test('accuracy grades same-day open/close direction only; flat loses and neutral stays outside denominator',()=>{
  const records=[gradeOracle(snapshot,pack.rows[0],history(),close),gradeOracle(snapshot,pack.rows[1],history(100,98),close),gradeOracle(snapshot,pack.rows[2],history(100,100),close),gradeOracle(snapshot,pack.rows[3],history(),close)];
  assert.deepEqual(records.map(r=>r.hit),[true,true,false,null]);
  const s=summarizeOracle(records);assert.equal(s.all.n,3);assert.equal(s.all.hits,2);assert.equal(s.all.rate,66.67);assert.equal(s.down.rate,100);assert.equal(s.up.rate,50);assert.equal(s.neutral,1);
  assert.equal(summarizeOracle([]).all.rate,null);assert.equal(s.all.days,1);
});
test('no lookahead: late casts, wrong model, holidays, incomplete bars and future dates cannot grade',()=>{
  assert.equal(gradeOracle(snapshot,pack.rows[0],history(),close-1).status,'pending');
  for(const patch of [{recordedAt:new Date(Date.parse(`${date}T13:30Z`)).toISOString()},{recordedAt:'bad'},{method:'old'},{rule:'other'},{date:'2026-09-20'}])assert.equal(gradeOracle({...snapshot,...patch},pack.rows[0],history(),close).status,'excluded');
  for(const h of [history(100,102,'2026-09-22'),history(null,102),{...history(),source:null},{ok:true,source:'test',bars:[...history().bars,...history().bars]},history(100,NaN)])assert.equal(gradeOracle(snapshot,pack.rows[0],h,close).status,'missing');
  const early={...snapshot,date:'2026-11-27',recordedAt:'2026-11-27T12:00:00Z'};
  assert.equal(gradeOracle(early,pack.rows[0],history(100,102,early.date),Date.parse('2026-11-27T18:15Z')).status,'locked');
});
test('first snapshot is immutable, repeated refresh deduplicates, GET is read-only, settled results survive restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oracle-score-'));let clock=pre,calls=0;
  const store=createOracleAccuracy({dir,now:()=>clock,loader:async(symbol,opts)=>{calls++;assert.equal(opts.refresh,true);return history(100,symbol==='DOWN'?98:symbol==='FLAT'?100:102);}});
  assert.equal((await store.read()).summary.all.rate,null);assert.deepEqual(await readdir(dir),[]);
  await Promise.all([store.refresh(pack),store.refresh({...pack,rows:[]})]);
  const file=(await readdir(dir))[0],before=await readFile(join(dir,file),'utf8');
  await store.refresh({...pack,rows:[{symbol:'OTHER',direction:'down'}]});assert.equal(await readFile(join(dir,file),'utf8'),before);
  assert.equal((await store.read({date})).summary.pending,3);assert.equal(calls,0);
  clock=close;const graded=await store.refresh(pack);assert.equal(graded.summary.all.n,3);assert.equal(calls,3);
  await store.refresh(pack);assert.equal(calls,3);
  const restarted=createOracleAccuracy({dir,now:()=>clock,loader:async()=>{throw Error('should not fetch');}});
  assert.equal((await restarted.read({date})).summary.all.rate,66.67);assert.equal((await restarted.read({date})).selected.count,4);
});
test('missed or retrospective capture never writes; missing exact bars retry without borrowing next day',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oracle-missing-'));let clock=close;
  const store=createOracleAccuracy({dir,now:()=>clock,loader:async()=>history(100,102,'2026-09-22')});
  assert.equal((await store.refresh(pack)).selected.recordedAt,null);assert.deepEqual(await readdir(dir),[]);
  clock=pre;await store.refresh(pack);clock=close;
  const missing=await store.refresh(pack);assert.equal(missing.summary.missing,3);assert.equal(missing.summary.all.rate,null);
  const recovered=createOracleAccuracy({dir,now:()=>clock,loader:async()=>history()});
  assert.equal((await recovered.refresh(pack)).summary.all.n,3);
});
test('corrupt snapshot and result files stay intact and cannot silently become a valid accuracy rate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oracle-corrupt-'));
  const path=join(dir,`${METHOD}--${RULE}--${date}.json`);await writeFile(path,'broken');
  const store=createOracleAccuracy({dir,now:()=>pre});const summary=await store.refresh(pack);
  assert.equal(summary.errors.length,1);assert.equal(summary.summary.all.rate,null);assert.equal(await readFile(path,'utf8'),'broken');
  const resultPath=join(dir,`${METHOD}--${RULE}--results.json`);await writeFile(resultPath,'broken');
  await assert.rejects(store.refresh(pack),/损坏/);assert.equal(await readFile(resultPath,'utf8'),'broken');
});
