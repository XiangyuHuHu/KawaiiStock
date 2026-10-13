import test from 'node:test';
import assert from 'node:assert/strict';
import { finiteNumber } from '../src/numbers.js';
import { assertOrder, limitTracksQuote, orderRisk, positionRisk, findPosition } from '../src/risk/gateway.js';
import { evaluateFreshness } from '../src/risk/freshness.js';
import { normCdf, blackScholes, patternMatches } from '../src/options/math.js';
import { historicalExecution } from '../src/sim-execution.js';
import { paperExecution, orderFingerprint } from '../src/paper/execution.js';
import { sizeConfirmed, confirmCycle } from '../src/strategy/confirmation.js';
import { isCycleEntry, CYCLE_ID } from '../src/strategy/cycle.js';
import { sessionOpenMs, closedBars } from '../src/market-time.js';

const now = Date.parse('2026-09-10T15:00:00Z');
const order = { symbol: 'MU', instrument: 'equity', side: 'buy', qty: 10, limitPrice: 100, stopPrice: 90, maxLoss: null, inputs: { last: 100, quoteAt: now } };
const book = { nav: 10000, cash: 10000, buyingPower: 10000, positions: [], peakNav: 10000, mode: 'NORMAL' };
const limits = { caps: { maxOrderRisk: 100, maxSingleRisk: 150, maxThemeRisk: 200 } };
const check = (patch = {}, b = book, l = limits) => assertOrder({ ...order, ...patch }, b, l, { now });

test('missing values are not zero', () => { for (const value of [null, undefined, '', ' ', false, NaN, Infinity]) assert.equal(finiteNumber(value), null); assert.equal(finiteNumber('0'), 0); });
test('null and explicit zero cannot hide stop risk', () => { assert.equal(orderRisk(order), 100); assert.equal(orderRisk({ ...order, maxLoss: 0 }), 100); assert.equal(check({ qty: 100 }).code, 'max-loss-exceeded'); });
test('long option risk is full premium, not stop difference', () => assert.equal(orderRisk({ ...order, instrument: 'option', qty: 1, limitPrice: 5, stopPrice: 4, maxLoss: 0 }), 500));
test('unknown stop risk fails closed', () => assert.equal(check({ stopPrice: null }, book, { ...limits, requireStopOnOpen: false }).code, 'uncomputable-loss'));
test('invalid prices and stop side rejected', () => { for (const p of [0, -1, null, '']) assert.equal(check({ limitPrice: p }).ok, false); assert.equal(check({ stopPrice: 101 }).code, 'bad-stop-side'); });
test('reduceOnly cannot disguise buying more', () => assert.equal(check({ reduceOnly: true }, { ...book, positions: [{ ...order, qty: 20 }] }).code, 'invalid-reduce-only'));
test('reductions without known risk allowed in KILL', () => assert.equal(check({ side: 'sell', stopPrice: null }, { ...book, kill: true, positions: [{ ...order, qty: 20 }] }).ok, true));
test('pending orders reserve cash and symbol risk', () => { assert.equal(check({}, { ...book, buyingPower: 1500, openOrders: [order] }).code, 'buying-power'); assert.equal(check({}, { ...book, openOrders: [order] }).code, 'max-single-risk'); });
test('position total risk scales with shares', () => assert.equal(positionRisk({ qty: 30, last: 100, stopPrice: 90, maxLoss: 10 }), 300));
test('stock aliases match and option rights do not collide', () => { assert.ok(findPosition([{ symbol: 'MU', instrument: 'stock' }], order)); assert.equal(findPosition([{ symbol: 'MU', instrument: 'option', optionType: 'put' }], { ...order, instrument: 'option', optionType: 'call' }), null); });
test('old approved order ID cannot authorize execution', () => assert.equal(assertOrder({ ...order, id: 'one' }, book, limits, { now, seen: { one: { ok: true } } }).ok, false));
test('paper option reference quote can open one contract without a timestamp', () => {
  const opt = {
    symbol: 'GLW', instrument: 'option', side: 'buy', qty: 1, limitPrice: 0.502, stopPrice: 0.25,
    maxLoss: 50, optionType: 'call', expiration: '2026-10-09', strike: 152.5, dte: 11,
    ask: 0.5, bid: 0.45, structure: 'long', type: 'limit', paperReference: true, book: 'paper-0e',
    inputs: { last: 0.5, ask: 0.5, bid: 0.45, hasQuote: true, hasChain: false }
  };
  assert.equal(assertOrder(opt, book, limits, { now, book: 'paper-0e' }).ok, true);
  assert.equal(assertOrder({ ...opt, dte: 0.2 }, book, limits, { now, book: 'paper-0e' }).code, 'short-dated-forbidden');
  const held = { symbol: 'GLW', instrument: 'option', qty: 1, optionType: 'call', expiration: '2026-10-09', strike: 152.5, last: 0.5 };
  assert.equal(assertOrder({ ...opt, dte: 0.2, side: 'sell', qty: 1, reduceOnly: true }, { ...book, positions: [held] }, limits, { now, book: 'paper-0e' }).ok, true);
  assert.equal(assertOrder({ ...opt, book: 'live' }, book, limits, { now, book: 'live' }).code, 'reference-not-allowed');
  assert.equal(assertOrder(opt, { ...book, holdingsFresh: false, positions: [{ symbol: 'ANET', instrument: 'option', qty: 1, optionType: 'call', expiration: '2026-10-09', strike: 205 }] }, limits, { now, book: 'paper-0e' }).ok, true);
  const stock = {
    symbol: 'OKLO', instrument: 'equity', side: 'buy', qty: 10, limitPrice: 100.2, stopPrice: 92,
    maxLoss: 80, theme: 'oracle', type: 'limit', paperReference: true, book: 'paper-0d',
    inputs: { last: 100, quoteAt: now - 3600000, hasQuote: true }
  };
  assert.equal(assertOrder(stock, { ...book, holdingsFresh: false }, limits, { now, book: 'paper-0d' }).ok, true);
  assert.equal(assertOrder({ ...stock, book: 'live' }, book, limits, { now, book: 'live' }).code, 'reference-not-allowed');
});
test('open limit must stay within 1.5 percent of the quote used', () => {
  const pass = check({ limitPrice: 101, stopPrice: 91 });
  assert.equal(pass.ok, true);
  assert.equal(pass.quoteSeal.length, 16);
  assert.equal(check({ limitPrice: 103, stopPrice: 93 }).code, 'limit-away-from-quote');
  assert.equal(check({ inputs: { quoteAt: now } }).code, 'quote-unbound');
  assert.equal(limitTracksQuote(order).seal.length, 16);
});
test('source timestamp required, fetch timestamp not a substitute', () => { for (const ts of ['invalid', null, '', now + 60000]) assert.equal(evaluateFreshness({ last: 100, quoteAt: ts, fetchedAt: now }, now).fresh, false); assert.equal(evaluateFreshness({ quoteAt: new Date(now).toISOString() }, now).fresh, true); });
test('option chain needs its own timestamp', () => assert.equal(evaluateFreshness({ quoteAt: now, chainOk: true, requireChain: true, fetchedAt: now }, now).fresh, false));
test('normal CDF known values and symmetry', () => { assert.ok(Math.abs(normCdf(1) - 0.841344746) < 1e-7); assert.ok(Math.abs(normCdf(-1) + normCdf(1) - 1) < 1e-10); });
test('Black Scholes known price and put-call parity', () => { const args = { spot: 100, strike: 100, dte: 365, iv: .2, rate: .05 }; const call = blackScholes(args).price; const put = blackScholes({ ...args, type: 'put' }).price; assert.ok(Math.abs(call - 10.45058357) < 0.0001); assert.ok(Math.abs(call - put - (100 - 100 * Math.exp(-.05))) < .0001); });
test('analog samples are purged and non-overlapping', () => { const bars = Array.from({ length: 300 }, (_, i) => ({ date: `d${i}`, close: 100 + i, high: 101 + i, low: 99 + i })); const p = patternMatches(bars, { length: 8, horizon: 12, maxDist: 100 }); assert.ok(p.matches <= Math.floor(300 / 20)); });
test('paper limit 1 does not fill when quote is 100', () => assert.equal(paperExecution({ ...order, limitPrice: 1 }, { ok: true, last: 100, quoteAt: now }, now).code, 'limit-not-marketable'));
test('paper costs applied within limit', () => { const fill = paperExecution({ ...order, limitPrice: 101 }, { ok: true, last: 100, quoteAt: now }, now); assert.equal(fill.ok, true); assert.ok(Math.abs(fill.price - 100.05) < 1e-9); });
test('paper missing quotes and option underlying substitution rejected', () => { assert.equal(paperExecution(order, null, now).ok, false); assert.equal(paperExecution({ ...order, instrument: 'option' }, { ok: true, last: 100, quoteAt: now }, now).ok, false); });
test('fingerprint changes when quantity changes', () => assert.notEqual(orderFingerprint(order), orderFingerprint({ ...order, qty: 11 })));
test('historical execution only uses next open after known signal', () => { const bar = { date: '2026-09-10', open: 100 }; assert.equal(historicalExecution({ action: 'BUY', limitPrice: 101 }, bar, '2026-09-09T21:00:00Z').price, 100.05); assert.equal(historicalExecution({}, bar, '2026-09-10T15:00:00Z').ok, false); assert.equal(historicalExecution({}, bar, null).ok, false); });
test('expired historical signal does not trade', () => assert.equal(historicalExecution({ validUntil: '2026-09-09' }, { date: '2026-09-10', open: 100 }, '2026-09-09T20:00:00Z').ok, false));
test('session open respects DST and incomplete daily bars excluded', () => { assert.equal(new Date(sessionOpenMs('2026-09-10')).toISOString(), '2026-09-10T13:30:00.000Z'); assert.equal(new Date(sessionOpenMs('2026-01-06')).toISOString(), '2026-01-06T14:30:00.000Z'); assert.equal(closedBars([{ date: '2026-09-09' }, { date: '2026-09-10' }], new Date(now)).length, 1); });
test('v2 score cannot bypass failed confirmation', () => { const strategy = confirmCycle([], { id: CYCLE_ID, ok: false, allowNewLong: true, score: 100, tradeable: true, regime: 'risk-on' }); assert.equal(isCycleEntry({ strategy }), false); });
test('v2 size respects per-order, portfolio and notional caps', () => { const s = sizeConfirmed({ nav: 10000, cash: 10000, price: 100, stop: 90 }); assert.equal(s.qty, 5); assert.equal(sizeConfirmed({ nav: 10000, cash: 10000, price: 100, stop: 90, currentRisk: 250 }), null); assert.equal(sizeConfirmed({ nav: 10000, cash: 10000, price: 100, stop: 99 }).qty, 10); });
