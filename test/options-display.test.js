import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceContract, actionLabel } from '../public/options-display.js';

test('legacy single contract prices and expiration remain visible despite blocked eligibility', () => {
  const row={eligible:false,action:'NO_TRADE',contract:{type:'call',strike:220,expiration:'2026-09-25',bid:9.25,ask:9.75,symbol:'legacy',mid:9.5}};
  const view=referenceContract(row);
  assert.equal(view.legs[0].bid,9.25); assert.equal(view.legs[0].ask,9.75);
  assert.equal(view.legs[0].expiration,'2026-09-25'); assert.equal(view.legs[0].quoteAt,undefined);
  assert.equal(view.legs[0].multiplier,undefined); assert.equal(row.eligible,false);
});
test('new source legs stay visible even when aggregate cost and pricing fail verification', () => {
  const row={costs:{ok:false},contract:{bid:null,ask:null,legs:[{type:'put',strike:100,expiration:'2026-10-16',bid:3,ask:3.5,quoteAt:null}]}};
  assert.deepEqual(referenceContract(row).legs,row.contract.legs);
});
test('legacy multi-leg display does not invent missing prices or recycle the call as put', () => {
  const straddle=referenceContract({contract:{type:'straddle',expiration:'2026-09-25',bid:9,ask:10,callBid:9,callAsk:10,callStrike:100,putStrike:100}});
  assert.equal(straddle.legs[0].bid,9); assert.equal(straddle.legs[1].bid,undefined);
  assert.equal(straddle.legs[1].ask,undefined); assert.equal(straddle.incomplete,true);
  const spread=referenceContract({contract:{type:'put',strike:100,shortStrike:95,bid:4,ask:5,shortBid:2,shortAsk:3,expiration:'2026-09-25'}});
  assert.equal(spread.legs[0].ask,5);assert.equal(spread.legs[1].ask,3);assert.equal(spread.legs[1].side,'sell');
});
test('explicit recommendation names are kept distinct from no trade and missing contracts', () => {
  assert.equal(actionLabel('BUY_CALL'),'买入 Call'); assert.equal(actionLabel('BUY_PUT'),'买入 Put');
  assert.equal(actionLabel('NO_TRADE'),'暂不买入'); assert.deepEqual(referenceContract({}).legs,[]);
});

test('assessment separates historical, missing data, and evaluated negative edge', async () => {
  const { assessment }=await import('../public/options-display.js');
  const old=assessment({action:'NO_TRADE',optionEv:.3},{currentModel:false});
  assert.equal(old.kind,'history');assert.equal(old.evLabel,'待重算');
  const missing=assessment({action:'NO_TRADE',reason:'股票方向可能对，但这个期权不值得买',blockers:['每腿 Bid/Ask 报价时间缺失']},{currentModel:true,fresh:false});
  assert.equal(missing.kind,'data');assert.equal(missing.evLabel,'未计算');assert.ok(!missing.reason.includes('不值得买'));
  const fee=assessment({blockers:['手续费未填写，净收益不可评估']},{currentModel:true,fresh:true});
  assert.equal(fee.kind,'data');
  const noEdge=assessment({action:'NO_TRADE',evEstimate:{perGroup:-12},blockers:['净 EV 缺失或不为正']},{currentModel:true,fresh:true});
  assert.equal(noEdge.kind,'no-edge');
  assert.equal(assessment({action:'BUY_CALL'},{currentModel:true,fresh:true,eligible:true}).kind,'candidate');
});
