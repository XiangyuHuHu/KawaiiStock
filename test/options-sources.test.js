import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseUnderlyingQuote, parseEarningsDate, sourceDiagnostics } from '../src/options/sources.js';
import { mapTradierContract, tradierGet, loadTradierChain, providerStatus } from '../src/options/providers.js';
const now=Date.parse('2026-09-16T15:00:00Z');

test('quote selection keeps price/time paired, chooses latest timed source, never borrows a time',()=>{
  const a=chooseUnderlyingQuote({last:99,source:'nasdaq'},{last:100,quoteAt:now-1000,source:'yahoo'},{last:101,quoteAt:now-500,source:'chart'},now);
  assert.equal(a.last,101);assert.equal(a.quoteAt,now-500);assert.equal(a.source,'chart');
  const missing=chooseUnderlyingQuote({last:99},{quoteAt:now},{},now);assert.equal(missing.quoteAt,null);assert.equal(missing.last,99);
  const future=chooseUnderlyingQuote({last:120,underlyingQuoteAt:now+60000},{last:100,quoteAt:now},{},now);assert.equal(future.last,100);
});
test('earnings parser only accepts valid explicitly upcoming date, leaves unknown and past dates unknown',()=>{
  assert.equal(parseEarningsDate({announcement:'Earnings announcement* for ABC: Nov 18, 2026'},now).date,null);
  assert.equal(parseEarningsDate({reportText:'ABC is estimated to report earnings on 11/18/2026.'},now).date,'2026-11-18');
  for(const text of ["Our vendor hasn't provided us with the upcoming earnings report date.",'Next 02/30/2027','Next 09/15/2026','No date']) assert.equal(parseEarningsDate({reportText:text},now).date,null);
});
test('Tradier maps bid/ask independently; missing side time or nonstandard deliverable never passes',()=>{
  const raw={symbol:'ABC261016C00100000',underlying:'ABC',root_symbol:'ABC',option_type:'call',contract_size:100,expiration_date:'2026-10-16',strike:100,bid:2,ask:2.1,bid_date:now-1000,ask_date:now,trade_date:now,open_interest:100,volume:5,greeks:{mid_iv:.4}};
  const leg=mapTradierContract(raw);assert.equal(leg.quoteAt,now-1000);assert.equal(leg.standard,true);assert.equal(leg.iv,null);
  assert.equal(mapTradierContract({...raw,bid_date:null}).quoteAt,null);
  assert.equal(mapTradierContract({...raw,root_symbol:'ABC1'}).standard,false);
  assert.equal(mapTradierContract(raw,{sandbox:true}).quoteMode,'delayed');
});
test('optional provider uses GET-only allowlisted market endpoints and sanitized errors',async()=>{
  assert.equal(providerStatus({}).configured,false);
  const calls=[]; const env={TRADIER_TOKEN:'test-only-token'};
  const fetcher=async(url,opts)=>{calls.push({url,method:opts.method});return {ok:true,json:async()=>url.includes('expirations')?{expirations:{date:['2026-10-16']}}:url.includes('/chains')?{options:{option:{symbol:'ABC261016C00100000',underlying:'ABC',root_symbol:'ABC',option_type:'call',contract_size:100,expiration_date:'2026-10-16',strike:100,bid:2,ask:2.1,bid_date:now,ask_date:now}}}:{quotes:{quote:{symbol:'ABC',last:100,trade_date:now,type:'stock'}}}};};
  const chain=await loadTradierChain('ABC',null,{env,fetcher});assert.equal(chain.calls.length,1);assert.equal(chain.underlyingQuoteAt,now);
  assert.ok(calls.every(c=>c.method==='GET'&&c.url.startsWith('https://api.tradier.com/v1/markets/')));
  await assert.rejects(tradierGet('/accounts/orders',{}, {env,fetcher}),/只允许行情/);
  await assert.rejects(tradierGet('/markets/quotes',{}, {env,fetcher:async()=>({ok:false,status:401})}),/HTTP 401/);
});
test('source diagnosis treats unannounced earnings and untimed option quotes as missing',()=>{
  const fields=sourceDiagnostics({quoteAt:now,quoteSource:'yahoo',chain:{source:'nasdaq',earnings:{status:'unknown',date:null},calls:[{quoteAt:null}],puts:[]}},now);
  assert.equal(fields.find(f=>f.key==='earnings').status,'missing');assert.equal(fields.find(f=>f.key==='optionQuotes').status,'missing');
});
