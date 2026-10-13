import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRec, orderToRec } from '../src/sim.js';

const rec = { symbol: 'TEST', action: 'BUY', tradeQty: 1, limitPrice: 101, generatedAt: '2026-09-09T21:00:00Z' };
const quotes = { TEST: { ok: true, last: 999, bar: { date: '2026-09-10', open: 100, close: 105 } } };
test('leveraged equity ETF is not misclassified as an option', () => assert.equal(orderToRec({ symbol: 'ORCX', instrument: '2x-leveraged-equity-etf', side: 'buy', quantity: 1 }).action, 'BUY'));
test('simulation uses historical open, not latest quote', () => {
  const book = { cash: 1000, positions: [] };
  const result = applyRec(book, rec, quotes, 'test');
  assert.equal(result.fill.price, 100.05);
  assert.equal(result.fill.execution.model, 'next-open-v2');
});
test('missing historic bar cannot use old position price', () => {
  const book = { cash: 1000, positions: [{ symbol: 'TEST', qty: 1, last: 100, avgCost: 100 }] };
  assert.equal(applyRec(book, { ...rec, action: 'SELL' }, {}, 'test').fill, null);
  assert.equal(book.positions[0].qty, 1);
});
test('invalid or missing buy/add quantity never fabricates shares', () => {
  for (const qty of [NaN, Infinity, -1, 0, null]) {
    const book = { cash: 1000, positions: [] };
    assert.equal(applyRec(book, { ...rec, tradeQty: qty, action: 'ADD' }, quotes, 'test').fill, null);
    assert.equal(book.cash, 1000);
  }
});
test('small fractional remainder is retained on a trim', () => {
  const book = { cash: 0, positions: [{ symbol: 'TEST', qty: 0.012345, avgCost: 100, last: 100 }] };
  const result = applyRec(book, { ...rec, action: 'TRIM', tradeQty: .01, limitPrice: 99 }, quotes, 'test');
  assert.ok(result.fill);
  assert.equal(book.positions[0].qty, .002345);
});
