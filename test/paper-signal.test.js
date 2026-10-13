import test from 'node:test';
import assert from 'node:assert/strict';
import { paperDeskOf } from '../src/risk/limits.js';
import { hexagramLongs, qimenLongs, oracleLongs, oracleExit, optionGainExit, optionLossExit, optionPaperExit, oracleTradable, optionLongs, optionPaperLongs, sameOptionContract, sizeOptionContracts } from '../src/paper/signals.js';
import { paperExecution } from '../src/paper/execution.js';

const session = Date.parse('2026-09-25T14:00:00Z');

test('paper desks keep 0d and 0e distinct from 0b', () => {
  assert.equal(paperDeskOf('0d'), '0d');
  assert.equal(paperDeskOf('paper-0e'), '0e');
  assert.equal(paperDeskOf('live'), null);
  assert.equal(paperDeskOf('nope'), '0b');
});

test('oracle longs only take US names on open or life door', () => {
  const rows = oracleLongs([
    { market: 'us', symbol: 'mu', direction: 'up', score: 2 },
    { market: 'us', symbol: 'ASTS', direction: 'up', score: 1 },
    { market: 'cn', symbol: '600519', direction: 'up', score: 2 },
    { market: 'us', symbol: 'GLW', direction: 'down', score: -2 }
  ]);
  assert.deepEqual(rows.map((row) => row.symbol), ['MU']);
  assert.deepEqual(qimenLongs([{ market: 'us', symbol: 'QQQ', direction: 'up', score: 2 }, { market: 'us', symbol: 'DIA', direction: 'up', score: 1 }, { market: 'us', symbol: 'ANET', direction: 'up', score: 0 }]).map((row) => row.symbol), ['QQQ', 'DIA']);
  assert.deepEqual(hexagramLongs([{ symbol: 'oklo', direction: 'up' }, { symbol: 'MU', direction: 'neutral' }]).map((row) => row.symbol), ['OKLO']);
  assert.equal(oracleTradable({ symbol: 'MU' }, { confirmed: new Set(['MU']), buys: new Set() }), 'watch');
  assert.equal(oracleTradable({ symbol: 'GLW' }, { confirmed: new Set(), buys: new Set(['ASTS']) }), null);
  assert.equal(oracleExit({ direction: 'down', score: -1 }), 'down');
  assert.equal(oracleExit({ direction: 'neutral', score: 0 }), null);
  assert.equal(optionGainExit(10, 14), true);
  assert.equal(optionGainExit(10, 13.9), false);
  assert.equal(optionLossExit(10, 8), true);
  assert.equal(optionLossExit(10, 8.1), false);
  assert.equal(optionPaperExit({ avgCost: 10, bid: 15, ask: 15.2, listed: true, openedBeforeToday: true }), null);
  assert.equal(optionPaperExit({ avgCost: 10, bid: 15, ask: 15.2, listed: false, openedBeforeToday: false }), null);
  assert.equal(optionPaperExit({ avgCost: 10, bid: 15, ask: 15.2, listed: false, openedBeforeToday: true }), 'tp');
  assert.equal(optionPaperExit({ avgCost: 10, bid: 7.5, ask: 8.5, listed: true, openedBeforeToday: false }), 'stop');
  assert.equal(optionPaperExit({ avgCost: 0.590295, bid: 0.45, ask: 0.59, listed: true, openedBeforeToday: false }), null);
});

test('option paper only accepts a fresh single-leg buy', () => {
  const now = session;
  const leg = { type: 'put', expiration: '2026-10-09', strike: 63, bid: 3.6, ask: 5.05, quoteAt: now - 1000 };
  const ideas = [
    { symbol: 'ASTS', originalAction: 'NO_TRADE', action: 'NO_TRADE', eligible: false, costs: { ok: true }, contract: { legs: [leg] } },
    { symbol: 'RXRX', originalAction: 'BUY_CALL', action: 'BUY_CALL', eligible: true, costs: { ok: true, entryAsk: 0.41 }, contract: { legs: [{ ...leg, type: 'call', quoteAt: null, bid: 0.38, ask: 0.41 }] } },
    { symbol: 'TOST', originalAction: 'BUY_PUT', action: 'BUY_PUT', eligible: true, costs: { ok: true, entryAsk: 0.74 }, contract: { legs: [{ ...leg, type: 'put', strike: 30, bid: 0.52, ask: 0.74, quoteAt: now - 1000 }] } }
  ];
  const longs = optionLongs(ideas, now);
  assert.equal(longs.length, 1);
  assert.equal(longs[0].symbol, 'TOST');
  assert.equal(sizeOptionContracts(0.74, 100000, 100000, { cashFloorPct: 0.4, maxNamePct: 0.15 }).qty, 40);
  const paper = optionPaperLongs([{ symbol: 'GLW', direction: 'up', action: 'NO_TRADE', contract: { legs: [{ side: 'buy', type: 'call', expiration: '2026-10-09', strike: 152.5, bid: 5.35, ask: 5.9 }] } }]);
  assert.equal(paper.length, 1);
  assert.equal(paper[0].reference, true);
  const ref = { side: 'buy', type: 'call', expiration: '2026-10-09', strike: 152.5, bid: 5.35, ask: 5.9, dte: 9 };
  assert.equal(optionPaperLongs([{ symbol: 'A', direction: 'none', contract: { legs: [ref] } }]).length, 0);
  assert.equal(optionPaperLongs([{ symbol: 'B', direction: 'down', contract: { legs: [ref] } }]).length, 0);
  assert.equal(optionPaperLongs([{ symbol: 'C', direction: 'up', earningsInDays: 5, contract: { legs: [ref] } }]).length, 0);
  assert.equal(optionPaperLongs([{ symbol: 'D', direction: 'up', ivLabel: 'extreme', contract: { legs: [ref] } }]).length, 0);
  assert.equal(optionPaperLongs([{ symbol: 'E', direction: 'up', contract: { legs: [{ ...ref, bid: 4, ask: 6 }] } }]).length, 0);
  assert.equal(optionPaperLongs([{ symbol: 'F', direction: 'up', earningsInDays: 30, contract: { legs: [ref] } }]).length, 1);
});

test('final option decision and full contract identity gate paper fills', () => {
  const leg = { type: 'call', expiration: '2026-10-09', strike: 63, bid: 1, ask: 1.1, quoteAt: session - 1000 };
  const base = { symbol: 'MU', eligible: true, costs: { ok: true }, contract: { legs: [leg] } };
  assert.deepEqual(optionLongs([{ ...base, originalAction: 'BUY_CALL', action: 'NO_TRADE' }], session), []);
  assert.deepEqual(optionLongs([{ ...base, originalAction: 'BUY_PUT', action: 'BUY_CALL' }], session), []);
  assert.deepEqual(optionLongs([{ ...base, action: 'BUY_PUT' }], session), []);
  assert.deepEqual(optionLongs([{ ...base, action: 'BUY_CALL', contract: { legs: [{ ...leg, quoteMode: 'delayed' }] } }], session), []);
  assert.deepEqual(optionLongs([{ ...base, action: 'BUY_CALL', contract: { legs: [{ ...leg, standard: false, multiplier: 10 }] } }], session), []);
  const [candidate] = optionLongs([{ ...base, action: 'BUY_CALL' }], session);
  assert.equal(sameOptionContract({ ...candidate, symbol: 'NVDA' }, candidate), false);
  assert.equal(sameOptionContract({ ...candidate, optionType: 'put' }, candidate), false);
  assert.equal(sameOptionContract(candidate, candidate), true);
});

test('option execution refuses stock prices and stale contract quotes', () => {
  const missing = paperExecution({ instrument: 'option', side: 'buy', qty: 1, limitPrice: 5 }, { ok: true, last: 61, quoteAt: session }, session);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'contract-quote-required');
  const stale = paperExecution({
    instrument: 'option', side: 'buy', qty: 1, limitPrice: 5.1
  }, { ok: true, bid: 3.6, ask: 5.05, last: 5.05, quoteAt: session - 181000 }, session);
  assert.equal(stale.code, 'quote-stale');
  const reference = paperExecution({
    instrument: 'option', side: 'buy', qty: 1, limitPrice: 5.9 * 1.002, paperReference: true
  }, { ok: true, bid: 5.35, ask: 5.9, last: 5.9, quoteAt: null }, session);
  assert.equal(reference.ok, true);
  assert.equal(reference.model, 'paper-option-reference-v1');
  const filled = paperExecution({
    instrument: 'option', side: 'buy', qty: 1, limitPrice: 5.1
  }, { ok: true, bid: 3.6, ask: 5.05, last: 5.05, quoteAt: session - 1000 }, session);
  assert.equal(filled.ok, true);
  assert.ok(filled.price > 5.05 && filled.price < 5.1);
  const staleStock = paperExecution({
    instrument: 'equity', side: 'buy', qty: 10, limitPrice: 100 * 1.002
  }, { ok: true, last: 100, quoteAt: session - 181000 }, session);
  assert.equal(staleStock.code, 'quote-stale');
  const stockReference = paperExecution({
    instrument: 'equity', side: 'buy', qty: 10, limitPrice: 100 * 1.002, paperReference: true
  }, { ok: true, last: 100, quoteAt: session - 181000 }, session);
  assert.equal(stockReference.ok, true);
  assert.equal(stockReference.model, 'paper-equity-reference-v1');
  const optionExit = paperExecution({
    instrument: 'option', side: 'sell', qty: 1, limitPrice: 8.26 * 0.998, paperReference: true
  }, { ok: true, bid: 8.26, ask: 8.5, last: 8.5, quoteAt: null }, session);
  assert.equal(optionExit.ok, true);
  assert.equal(optionExit.model, 'paper-option-reference-exit-v1');
});

test('paper execution does not simulate a fill on a listed US market holiday', () => {
  const holiday = Date.parse('2026-01-01T16:00:00Z');
  const order = { instrument:'equity',side:'buy',qty:1,limitPrice:101 };
  const quote = { ok:true,last:100,bid:99.9,ask:100.1,quoteAt:holiday-1000 };
  assert.equal(paperExecution(order, quote, holiday).code, 'outside-session');
});
