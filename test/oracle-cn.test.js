import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {oracleMarket,isChinaOracleSession,nextChinaOracleSession} from '../src/oracle/markets.js';
import {buildSymbolOracle,castSymbol} from '../src/oracle/symbols.js';
import {RULE,gradeOracle,createOracleAccuracy} from '../src/oracle/accuracy.js';
import {parseChinaDaily,loadChinaOracleHistory} from '../src/oracle/cn-data.js';
const date='2026-09-21',pre=Date.parse(`${date}T09:14:00+08:00`),due=Date.parse(`${date}T15:15:00+08:00`);
const snapshot={market:'cn',method:'meihua-cn-v1',rule:RULE,date,recordedAt:new Date(pre).toISOString()};
const row={symbol:'002364',direction:'up'};
const h={ok:true,source:'test',bars:[{date,open:10,close:11,high:12,low:9,volume:100}]};
test('CN calendar excludes exchange holidays and weekend make-up workdays; clocks independent of US DST',()=>{
  for(const day of ['2026-02-16','2026-02-23','2026-09-20','2026-09-25','2026-10-01','2026-10-07','2026-10-10','2027-01-04'])assert.equal(isChinaOracleSession(day),false,day);
  assert.equal(nextChinaOracleSession('2026-09-24'),'2026-09-28');assert.equal(nextChinaOracleSession('2026-09-30'),'2026-10-08');
  assert.equal(new Date(oracleMarket('cn').cutoff(date)).toISOString(),'2026-09-21T01:15:00.000Z');
  assert.equal(new Date(oracleMarket('cn').close(date)).toISOString(),'2026-09-21T07:00:00.000Z');
  assert.equal(oracleMarket('cn').today(new Date('2026-09-20T17:00Z')),'2026-09-21');
  assert.equal(oracleMarket('us').today(new Date('2026-09-20T17:00Z')),'2026-09-20');
});
test('CN numeric symbols retain leading zero and names; old US cast remains stable',async()=>{
  const p=await buildSymbolOracle({market:'cn',now:pre,universeLoader:async()=>[{symbol:'002364',name:'中恒电气'},{symbol:'002364',name:'中恒电气'}]});
  assert.equal(p.rows.length,1);assert.equal(p.rows[0].symbol,'002364');assert.equal(p.rows[0].name,'中恒电气');assert.equal(p.timeZone,'Asia/Shanghai');
  assert.equal(p.method,'meihua-cn-v1');assert.equal(p.date,date);
  assert.deepEqual(castSymbol('NVDA',date),castSymbol('NVDA',date,'us'));
  assert.throws(()=>castSymbol('NVDA',date,'cn'));assert.throws(()=>castSymbol('002364',date,'us'));
});
test('CN accuracy stops capture at opening auction; lunch and zero volume cannot settle',()=>{
  assert.equal(gradeOracle(snapshot,row,h,Date.parse(`${date}T11:31:00+08:00`)).status,'pending');
  assert.equal(gradeOracle(snapshot,row,h,due-1).status,'pending');assert.equal(gradeOracle(snapshot,row,h,due).hit,true);
  assert.equal(gradeOracle({...snapshot,recordedAt:`${date}T09:15:00+08:00`},row,h,due).status,'excluded');
  assert.equal(gradeOracle(snapshot,row,{...h,bars:[{...h.bars[0],volume:0}]},due).status,'missing');
});
test('CN and US snapshots/results stay isolated even when a directory is shared',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oracle-cn-'));let clock=pre;
  const cn=createOracleAccuracy({market:'cn',dir,now:()=>clock,loader:async()=>h});
  const us=createOracleAccuracy({dir,now:()=>clock,loader:async()=>h});
  const p={market:'cn',method:'meihua-cn-v1',date,rows:[row]};
  await cn.refresh(p);assert.equal((await cn.read()).summary.pending,1);assert.equal((await us.read()).records.length,0);
  await assert.rejects(us.refresh(p),/跨市场/);
  clock=due;assert.equal((await cn.refresh(p)).summary.all.rate,100);assert.equal((await us.read()).summary.all.rate,null);
  assert.ok((await readdir(dir)).every(n=>n.startsWith('meihua-cn-v1--')));
});
test('CN daily parser checks stock identity, missing values and raw unadjusted source selection',async()=>{
  assert.equal(parseChinaDaily({code:'600000',klines:[]},'002364').ok,false);
  const p=parseChinaDaily({code:'002364',klines:['2026-09-21,10,11,12,9,100','2026-09-22,,11,12,9,0']},'002364');assert.equal(p.bars[1].open,null);
  let url;
  const loaded=await loadChinaOracleHistory('002364',{fetcher:async u=>{url=u;return {ok:true,json:async()=>({data:{code:'002364',klines:['2026-09-21,10,11,12,9,100']}})};}});
  assert.ok(url.includes('fqt=0'));assert.equal(loaded.bars[0].open,10);
  await assert.rejects(loadChinaOracleHistory('../data'),/代码无效/);
});
