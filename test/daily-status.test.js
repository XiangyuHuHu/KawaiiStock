import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDailyJob } from '../src/daily-status.js';
const valid=()=>({
  ...Object.fromEntries(['narrative','sim','tradable','posters','options','oracle','watchlist','watchlistCn','brief','risk','events','guards','paper'].map(k=>[k,{ok:true}])),
  recommendations:{grok:{},chatgpt:{}},verify:{complete:true,missing:[]},holdings:{}
});
test('a recommendation file alone cannot mask failed settlement or incomplete daily outputs',()=>{
  const p=valid();p.sim={error:'模拟结算只允许已收盘的交易日'};p.verify={ok:true,complete:false,missing:['simulation.json']};
  const s=summarizeDailyJob(p);assert.equal(s.ok,false);assert.equal(s.status,'partial');
  assert.deepEqual(s.errors.map(r=>r.step),['sim','files']);
});
test('partial tasks, missing ChatGPT recommendation and stale inputs are independently disclosed',()=>{
  const p=valid();p.recommendations.chatgpt=null;p.options.ok=false;p.narrative.stale=true;p.holdings.agentic={stale:true};
  const s=summarizeDailyJob(p);assert.equal(s.ok,true);assert.equal(s.errors.length,0);assert.equal(s.warnings.length,4);
  assert.equal(s.status,'completed_with_warnings');
});
test('required steps still fail the job: sim error, missing grok rec, missing files',()=>{
  const p=valid();p.sim={error:'模拟结算只允许已收盘的交易日'};
  assert.equal(summarizeDailyJob(p).ok,false);
  const q=valid();q.recommendations.grok=null;assert.equal(summarizeDailyJob(q).ok,false);
  const r=valid();r.verify={complete:false,missing:['x']};assert.equal(summarizeDailyJob(r).ok,false);
});
test('successful execution with old data is not described as fresh; zero fills are not failures',()=>{
  const p=valid();p.sim={grokFills:0,chatgptFills:0};p.narrative.stale=true;
  assert.equal(summarizeDailyJob(p).status,'completed_with_warnings');
  p.narrative.stale=false;assert.equal(summarizeDailyJob(p).status,'complete');
});
