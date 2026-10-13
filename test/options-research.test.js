import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteIssues, priceStructure, scenarioPnl, structureEv, MODEL_VERSION } from '../src/options/contracts.js';
import { reassessOptions } from '../src/options/safety.js';
import { horizonTarget, regularSession } from '../src/options/time.js';
import { settleForward, makeForwardRecords } from '../src/options/forward.js';
import { pickExpiration, loadBestChain, rankExpirations, mapYahooContract, mapNasdaqContract, listedEquityOptionUnit, pickUnderlyingQuoteAt, clearMarketCache } from '../src/options/market.js';
import { cleanBars } from '../src/historicals.js';
import { freshnessFromContext } from '../src/risk/freshness.js';
import { nextBar } from '../src/options/score.js';
import { evaluateCov } from '../src/options/cov.js';
const now = Date.parse('2026-09-15T15:00:00Z');
const leg = (extra = {}) => ({ contractSymbol: 'ABC260925C00100000', underlying: 'ABC', type: 'call', expiration: '2026-09-25', strike: 100, bid: 4.8, ask: 5, iv: .4, dte: 10, standard: true, multiplier: 100, quoteAt: now, volume: 10, openInterest: 100, side: 'buy', quantity: 1, ...extra });
const spread = () => [leg(), leg({ contractSymbol: 'ABC260925C00110000', strike: 110, side: 'sell', bid: 1.8, ask: 2 })];
const pack = () => ({ scanId: '11111111-1111-1111-1111-111111111111', date: '2026-09-15', generatedAt: new Date(now).toISOString(), modelVersion: MODEL_VERSION, costAssumptions: { feePerContract: .65 }, ideas: [{ symbol: 'ABC', action: 'BUY_CALL', contract: { legs: [leg()] }, optionEv: .2, patternMatches: 25, earningsInDays: 20, horizon: '60m', horizonDays: 1/24, targetAt: now+3600000, sourceTimes: { quoteAt: now, intraLastTs: now-300000 } }] });

test('quotes reject missing, zero, crossed, wide cheap options and no liquidity evidence', () => {
  for (const patch of [{bid:null},{bid:0},{ask:0},{bid:6},{bid:.1,ask:.3},{volume:0,openInterest:0}]) assert.ok(quoteIssues(leg(patch)).length);
  assert.equal(quoteIssues(leg()).length,0);
  assert.equal(priceStructure([leg({standard:false,multiplier:null})],0).ok,false);
});
test('single and vertical costs use executable sides, full multiplier and both-way fees', () => {
  const single = priceStructure([leg()], .65);
  assert.equal(single.entryCost,500.65); assert.equal(single.maxLoss,501.3);
  assert.equal(single.immediateGrossPnl,-20);
  const c = priceStructure(spread(), .65);
  assert.equal(c.entryAsk,3.2); assert.equal(c.exitBid,2.8);
  assert.equal(c.entryCost,321.3); assert.equal(c.maxLoss,322.6); assert.equal(c.maxProfit,677.4);
  assert.equal(c.stopPlan,1.44); assert.deepEqual(c.breakevens,[103.23]);
  assert.equal(priceStructure([leg()],null).maxLoss,null);
  assert.equal(priceStructure([leg()],0).maxLoss,500);
});
test('straddle requires same strike and expiration, combines both legs', () => {
  const put=leg({type:'put',contractSymbol:'ABC260925P00100000',bid:3.8,ask:4});
  const c=priceStructure([leg(),put],.65);
  assert.equal(c.debit,900); assert.equal(c.maxLoss,902.6); assert.equal(c.exitBid,8.6); assert.equal(c.stopPlan,4.05);
  assert.equal(priceStructure([leg(),{...put,strike:101}],0).ok,false);
  assert.equal(priceStructure([leg(),{...put,expiration:'2026-10-02'}],0).ok,false);
  assert.equal(priceStructure([leg(),leg()],0).ok,false);
});
test('revaluation obeys expiry payoff, spread cap and actual round trip friction', () => {
  const down=scenarioPnl({legs:spread(),spot:100,movePct:-10,elapsedDays:10,feePerContract:.65});
  const up=scenarioPnl({legs:spread(),spot:100,movePct:40,elapsedDays:10,feePerContract:.65});
  assert.equal(down.netPnl,-322.6); assert.equal(up.netPnl,677.4);
  const immediate=scenarioPnl({legs:[leg()],spot:100,feePerContract:.65});
  assert.equal(immediate.netPnl,-21.3);
  const normal=scenarioPnl({legs:[leg()],spot:100,elapsedDays:1,feePerContract:.65});
  const crush=scenarioPnl({legs:[leg()],spot:100,elapsedDays:1,ivChange:-.2,feePerContract:.65});
  assert.ok(crush.netPnl<normal.netPnl);
  assert.equal(structureEv({legs:[leg()],spot:100,forwards:[.01,.02],elapsedDays:1}).ev,null);
});
test('true source timestamps survive cleanup; fetch time and last trade are not bid/ask time', () => {
  assert.equal(cleanBars([{date:'2026-09-15T15:00:00Z',ts:now,open:100,high:101,low:99,close:100,volume:1}])[0].ts,now);
  const c=mapYahooContract({bid:4,ask:5,lastTradeDate:now/1000,contractSize:'REGULAR'},'call','2026-09-25');
  assert.equal(c.quoteAt,null); assert.equal(c.lastTradeAt,now);
  assert.equal(freshnessFromContext({fetchedAt:now,last:100,intra:[{ts:now}],chain:{ok:true,quoteAt:now}},now).fresh,false);
});
test('expiration selection fetches actual eligible expiry and fails closed on no match', async () => {
  const near=Date.parse('2026-09-16T00:00:00Z')/1000, next=Date.parse('2026-09-25T00:00:00Z')/1000;
  const first={ok:true,source:'yahoo',expiration:'2026-09-16',expirationDates:[near,next],calls:[leg({expiration:'2026-09-16'})],puts:[]};
  const requested=[];
  const result=await loadBestChain('ABC',{now:new Date(now),loader:async (symbol,ts)=>{requested.push(ts);return ts?{...first,expiration:'2026-09-25',calls:[leg()]}:first;}});
  assert.deepEqual(requested,[undefined,next]); assert.equal(result.expiration,'2026-09-25');
  assert.equal(pickExpiration(first,{minDte:3,maxDte:45,asOf:'2026-09-15'}).ok,false);
  assert.equal((await loadBestChain('ABC',{now:new Date(now),loader:async()=>first})).ok,false);
});
test('expiration ranking prefers about 14 days over the nearest weekly', async () => {
  const sep25 = Date.parse('2026-09-25T00:00:00Z') / 1000;
  const oct2 = Date.parse('2026-10-02T00:00:00Z') / 1000;
  const oct16 = Date.parse('2026-10-16T00:00:00Z') / 1000;
  const ranked = rankExpirations([sep25, oct2, oct16], { asOf: '2026-09-15' });
  assert.equal(ranked[0].date, '2026-10-02');
  const first = { ok: true, source: 'yahoo', expiration: '2026-09-25', expirationDates: [sep25, oct2, oct16], calls: [leg()], puts: [] };
  const requested = [];
  const result = await loadBestChain('ABC', {
    now: new Date(now),
    loader: async (_symbol, ts) => {
      requested.push(ts);
      if (!ts) return first;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      return { ...first, expiration: date, calls: [leg({ expiration: date })] };
    }
  });
  assert.equal(result.expiration, '2026-10-02');
  assert.equal(requested[1], oct2);
  const emptyThenWeekly = await loadBestChain('ABC', {
    now: new Date(now),
    loader: async (_symbol, ts) => {
      if (!ts) return first;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      if (date === '2026-10-02') return { ...first, expiration: date, calls: [], puts: [] };
      return { ...first, expiration: date, calls: [leg({ expiration: date })], puts: [] };
    }
  });
  assert.equal(emptyThenWeekly.expiration, '2026-09-25');
});
test('cached eligible rows lose eligibility as source ages; unknown fees and old model never pass', () => {
  assert.equal(reassessOptions(pack(),now).buys.length,1);
  assert.equal(reassessOptions(pack(),now+181000).buys.length,0);
  const old=pack(); delete old.modelVersion; assert.equal(reassessOptions(old,now).buys.length,0);
  const untimed=pack(); untimed.ideas[0].contract.legs[0].quoteAt=null; assert.equal(reassessOptions(untimed,now).buys.length,0);
  const noFees=pack(); noFees.costAssumptions.feePerContract=null; assert.equal(reassessOptions(noFees,now).buys.length,0);
  const p=pack(); p.ideas[0].optionEv=null; assert.equal(reassessOptions(p,now).buys.length,0);
});
test('trading horizons include overnight/weekends and 2026 early closes; unsupported calendar is unknown', () => {
  assert.equal(new Date(horizonTarget(Date.parse('2026-09-18T19:30:00Z'),'60m')).toISOString(),'2026-09-21T14:00:00.000Z');
  assert.equal(new Date(horizonTarget(Date.parse('2026-11-27T17:30:00Z'),'60m')).toISOString(),'2026-11-30T15:00:00.000Z');
  assert.equal(new Date(horizonTarget(now,'3d')).toISOString(),'2026-09-18T15:00:00.000Z');
  assert.equal(regularSession(Date.parse('2026-11-27T19:00:00Z')),false);
  assert.equal(horizonTarget(Date.parse('2027-01-05T15:00:00Z'),'60m'),null);
});
test('forward grading only accepts identical contracts in fixed quote window; missing data cannot be backfilled', () => {
  const record=makeForwardRecords(pack(),now)[0], exit=now+3600000;
  assert.equal(record.status,'pending');
  const chain={calls:[leg({bid:5.8,ask:6,quoteAt:exit})]};
  const graded=settleForward(record,chain,exit);
  assert.equal(graded.status,'locked'); assert.equal(graded.netPnl,78.7);
  assert.equal(settleForward(record,{calls:[leg({bid:5.8,ask:6,quoteAt:null})]},exit).status,'pending');
  assert.equal(settleForward(record,{calls:[leg({bid:5.8,ask:6,quoteAt:exit,strike:101})]},exit).status,'pending');
  assert.equal(settleForward(record,chain,exit+300001).status,'missing');
  assert.equal(settleForward(record,chain,exit-1).status,'pending');
  assert.equal(nextBar([{date:'2026-09-17',close:100}],'2026-09-15'),null);
});
test('COV missing chain produces explicit non-actionable reference, never fabricated net EV', () => {
  const row=evaluateCov({symbol:'ABC',asOf:'2026-09-15',now,last:100,intra:[],daily:[],chain:{ok:false,calls:[],puts:[]}});
  assert.equal(row.action,'NO_TRADE'); assert.equal(row.optionEv,null); assert.equal(row.maxRisk,null);
});

test('unknown earnings remain distinct from known events and explicit ETF exemption', () => {
  const p=pack(); p.ideas[0].earningsInDays=null;
  assert.ok(reassessOptions(p,now).ideas[0].blockers.includes('未来财报日期未核实'));
  p.ideas[0].earningsStatus='not-applicable';
  assert.equal(reassessOptions(p,now).buys.length,1);
  p.ideas[0].earningsStatus='estimated'; p.ideas[0].earningsInDays=2;
  assert.ok(reassessOptions(p,now).ideas[0].blockers.includes('观察视界内临近财报'));
  const ctx={symbol:'ABC',asOf:'2026-09-15',now,last:100,chain:{ok:false,calls:[],puts:[],earnings:{status:'estimated',date:'2026-09-30'}}};
  assert.equal(evaluateCov(ctx).earningsInDays,15);
  assert.equal(evaluateCov({...ctx,chain:{...ctx.chain,earnings:{status:'unknown',date:null}}}).earningsInDays,null);
});

test('fixed observation endpoint cannot outlive the contract or accept future side quotes', () => {
  const p=pack();p.ideas[0].targetAt=Date.parse('2026-09-25T20:00:00Z');
  assert.ok(reassessOptions(p,now).ideas[0].blockers.some(b=>b.includes('合约到期不晚于')));
  const future=pack();future.ideas[0].contract.legs[0].askAt=now+60000;
  assert.ok(reassessOptions(future,now).ideas[0].blockers.includes('合约报价时间在未来'));
  future.ideas[0].contract.legs[0].expiration='bad';
  assert.equal(reassessOptions(future,now).buys.length,0);
});

test('straddle decision requires its own positive net EV and spreads cannot bypass earnings gate', async () => {
  const { decisionFrom }=await import('../src/options/cov.js');
  const common={direction:'none',directionalScore:40,volatilityScore:80,ivLabel:'fair',evNaked:{ev:1},evSpread:{ev:1},earningsSoon:false,crowded:false,impliedMove:.02,expectedAbs:.04,horizonDays:1,dte:10};
  assert.equal(decisionFrom({...common,evStraddle:null}).action,'NO_TRADE');
  assert.equal(decisionFrom({...common,evStraddle:{ev:-.1}}).action,'NO_TRADE');
  assert.equal(decisionFrom({...common,evStraddle:{ev:.1}}).action,'STRADDLE');
  assert.equal(decisionFrom({...common,direction:'up',directionalScore:80,ivLabel:'expensive',earningsSoon:true}).action,'NO_TRADE');
});

test('contract-level expiry cannot be relabeled by the response envelope', () => {
  const mapped=mapYahooContract({expiration:Date.parse('2026-09-18T00:00:00Z')/1000},'call','2026-09-25');
  assert.equal(mapped.expiration,'2026-09-18');
});

test('listed OSI symbols infer 100-share units; last trade and fetch time stay off bid/ask', () => {
  const yahoo=mapYahooContract({bid:4,ask:5,lastTradeDate:now/1000,contractSymbol:'MRVL260925C00222500'},'call','2026-09-25','MRVL');
  assert.equal(yahoo.standard,true); assert.equal(yahoo.multiplier,100); assert.equal(yahoo.quoteAt,null);
  const mini=mapYahooContract({bid:4,ask:5,contractSize:'MINI',contractSymbol:'MRVL260925C00222500'},'call','2026-09-25','MRVL');
  assert.equal(mini.standard,false);
  const adjusted=listedEquityOptionUnit({contractSymbol:'MRVL1260925C00222500',underlying:'MRVL'});
  assert.equal(adjusted.standard,false);
  const nasdaqRow={drillDownURL:'https://www.nasdaq.com/market-activity/stocks/mrvl/option-chain/mrvl--260925c00222500',strike:222.5,c_Bid:8,c_Ask:9,p_Bid:8.6,p_Ask:9.8,c_Volume:10,p_Volume:104,c_Openinterest:20,p_Openinterest:73};
  const call=mapNasdaqContract(nasdaqRow,'call','2026-09-25','MRVL');
  const put=mapNasdaqContract(nasdaqRow,'put','2026-09-25','MRVL');
  assert.equal(call.contractSymbol,'mrvl--260925c00222500');
  assert.equal(put.contractSymbol,'mrvl--260925p00222500');
  assert.equal(call.standard,true); assert.equal(put.standard,true); assert.equal(put.quoteAt,null);
  assert.equal(pickUnderlyingQuoteAt({last:198.02}, {quoteAt:now}), now);
  assert.equal(pickUnderlyingQuoteAt({last:198.02,underlyingQuoteAt:null},{quoteAt:now}), now);
});

test('missing earnings is unverified, not an implied soon event that rejects a positive-EV call', async () => {
  const { decisionFrom }=await import('../src/options/cov.js');
  const base={direction:'up',directionalScore:80,volatilityScore:70,ivLabel:'fair',evNaked:{ev:1},evSpread:{ev:1},crowded:false,impliedMove:.02,expectedAbs:.04,horizonDays:1,dte:10};
  assert.equal(decisionFrom({...base,earningsSoon:false}).action,'BUY_CALL');
  assert.equal(decisionFrom({...base,earningsSoon:true}).action,'NO_TRADE');
});

test('yahoo option chain asks for a crumb before the v7 request', async () => {
  const { loadOptionChain } = await import('../src/options/market.js');
  clearMarketCache();
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    urls.push(href);
    if (href.includes('tradier.com')) throw new Error('no tradier');
    if (href.startsWith('https://finance.yahoo.com')) {
      const headers = new Headers();
      headers.append('set-cookie', 'A=1; Path=/');
      return new Response('<html>', { status: 200, headers });
    }
    if (href.includes('/v1/test/getcrumb')) return new Response('crumb123', { status: 200 });
    if (href.includes('/v7/finance/options/ANET')) {
      assert.match(href, /crumb=crumb123/);
      assert.match(init.headers.Cookie, /A=1/);
      return new Response(JSON.stringify({
        optionChain: { result: [{
          expirationDates: [1791504000],
          quote: {},
          options: [{ expirationDate: 1791504000, calls: [{ strike: 205, bid: 5.4, ask: 6.4, lastPrice: 6.13, expiration: 1791504000 }], puts: [] }]
        }] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected ${href}`);
  };
  try {
    const chain = await loadOptionChain('ANET', 1791504000, { refresh: true });
    assert.equal(chain.source, 'yahoo');
    assert.equal(chain.calls[0].bid, 5.4);
    assert.equal(chain.calls[0].expiration, '2026-10-09');
    assert.ok(urls.some((href) => href.includes('getcrumb')));
  } finally {
    globalThis.fetch = orig;
    clearMarketCache();
  }
});

test('refresh skips in-process option chain cache', async () => {
  const { loadOptionChain }=await import('../src/options/market.js');
  clearMarketCache();
  let n=0;
  const orig=globalThis.fetch;
  globalThis.fetch=async ()=>{ n+=1; throw new Error('http 418'); };
  try {
    await loadOptionChain('ZZZZ');
    const afterFirst=n;
    await loadOptionChain('ZZZZ');
    assert.equal(n, afterFirst);
    await loadOptionChain('ZZZZ', undefined, { refresh: true });
    assert.ok(n > afterFirst);
  } finally { globalThis.fetch=orig; clearMarketCache(); }
});
