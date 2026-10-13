import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createForwardStore, FORWARD_RULE } from '../src/options/forward.js';
import { createCollector } from '../src/options/collector.js';
import { compareRecords } from '../src/options/outcomes.js';
import { MODEL_VERSION } from '../src/options/contracts.js';
const t=Date.parse('2026-09-16T15:00:00Z');
const leg={contractSymbol:'ABC261016C00100000',type:'call',strike:100,expiration:'2026-10-16',side:'buy',quantity:1,bid:2,ask:2.1,quoteAt:t,standard:true,multiplier:100,volume:100,openInterest:100};
const cost={ok:true,debit:210,entryCost:210.65,roundTripFees:1.3,feePerContract:.65};
const record=(scanId,extra={})=>({id:`${scanId}:ABC`,scanId,symbol:'ABC',status:'pending',rule:FORWARD_RULE,modelVersion:MODEL_VERSION,horizon:'60m',entryAt:new Date(t-3600000).toISOString(),targetAt:t,legs:[leg],costs:cost,...extra});
const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];

test('collector groups identical requests, bypasses cache, serializes manual runs and never recollects locked rows',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'option-collector-'));let calls=0;
  for(const id of ids) await writeFile(join(dir,`${id}.json`),JSON.stringify({scanId:id,records:[record(id)]}));
  const store=createForwardStore({dir,now:()=>t,chainLoader:async(symbol,exp,opts)=>{calls++;assert.equal(opts.refresh,true);return {calls:[{...leg,bid:3,ask:3.1}],puts:[]};}});
  await Promise.all([store.refresh(),store.refresh()]);assert.equal(calls,1);
  const summary=await store.load({all:true});assert.equal(summary.groups[0].n,2);assert.ok(summary.records.every(r=>r.netPnl===88.7));
  const before=await readFile(join(dir,`${ids[0]}.json`),'utf8');await store.refresh();assert.equal(await readFile(join(dir,`${ids[0]}.json`),'utf8'),before);
});
test('restart misses elapsed windows honestly, retries within window and preserves corrupt files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'option-retry-'));let clock=t,calls=0;
  await writeFile(join(dir,`${ids[0]}.json`),JSON.stringify({scanId:ids[0],records:[record(ids[0])]}));
  await writeFile(join(dir,`${ids[1]}.json`),'broken');
  const store=createForwardStore({dir,now:()=>clock,chainLoader:async()=>{calls++;throw Error('network');}});
  let result=await store.refresh();assert.equal(result.pending,1);assert.equal(result.errors.length,1);assert.equal(result.records[0].attempts,1);
  clock+=300001;const restarted=createForwardStore({dir,now:()=>clock,chainLoader:async()=>{throw Error('must not fetch late');}});
  result=await restarted.refresh();assert.equal(result.missing,1);assert.equal(result.records[0].netPnl,undefined);assert.equal(calls,1);
  assert.equal(await readFile(join(dir,`${ids[1]}.json`),'utf8'),'broken');
});
test('idle collector performs no market requests or filesystem writes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'option-idle-'));const store=createForwardStore({dir,chainLoader:async()=>{throw Error('unexpected request');}});
  await store.refresh();assert.deepEqual(await readdir(dir),[]);
});
test('scheduler prevents overlap, recovers failure, pauses and resumes without external tasks',async()=>{
  const jobs=new Map();let seq=0,calls=0,release;
  const c=createCollector({now:()=>t,schedule:(fn)=>{jobs.set(++seq,fn);return seq;},cancel:id=>jobs.delete(id),refresh:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  c.start();assert.equal(jobs.size,1);
  const a=c.run(),b=c.run();assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);
  c.stop();release({collection:{requests:1},errors:[]});await a;assert.equal(jobs.size,0);assert.equal(c.status().enabled,false);
  const failed=createCollector({schedule:()=>1,cancel:()=>{},refresh:async()=>{throw Error('failed');}});await failed.run();assert.ok(failed.status().lastError);assert.equal(failed.status().running,false);
});
test('historical comparison only joins exact scan, legs, horizon, model and fee assumption',()=>{
  const snap={scanId:ids[0],date:'2026-09-16',modelVersion:MODEL_VERSION,costAssumptions:{feePerContract:.65},historicalBuys:[{symbol:'ABC',action:'BUY_CALL',horizon:'60m',contract:{legs:[leg]}}]};
  const win=record(ids[0],{status:'locked',netPnl:88.7,exitValue:300});
  assert.equal(compareRecords(snap,[win]).counts.locked,1);
  assert.equal(compareRecords(snap,[{...win,scanId:ids[1]}]).candidates[0].status,'no-baseline');
  for(const patch of [{horizon:'3d'},{modelVersion:'old'},{costs:{...cost,feePerContract:0}},{legs:[{...leg,strike:101}]},{rule:'other-rule'}]) {
    const c=compareRecords(snap,[{...win,...patch}]).candidates[0];assert.equal(c.status,'incompatible');assert.equal(c.netPnl,null);
  }
  const legacy=compareRecords({...snap,scanId:null,modelVersion:null},[win]);assert.equal(legacy.candidates[0].status,'no-baseline');assert.equal(legacy.candidates[0].netPnl,null);
});
