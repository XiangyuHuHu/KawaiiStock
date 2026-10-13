import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHoldingQuotes, holdingsFreshness } from '../src/holdings.js';

const book = {
  asOf: '2026-09-21T14:48:29.947Z',
  dataAsOf: '2026-09-21T14:48:29.947Z',
  cash: 100,
  cryptoValue: 0,
  stale: true,
  scanStatus: 'ok',
  positions: [
    { symbol: 'TOST', qty: 10, avgCost: 20, last: 25, marketValue: 250 },
    { symbol: 'DVLTZZZ', qty: 10, avgCost: 0, last: null, marketValue: 0 }
  ],
  optionPositions: [
    { symbol: 'KWEB', type: 'call', expiration: '2026-09-18', strike: 30, qty: 10, estimatedValue: 10 }
  ]
};

test('public quotes refresh prices without treating a missing placeholder as a gap', () => {
  const next = applyHoldingQuotes(book, { TOST: { ok: true, last: 30 } }, { date: '2026-10-09', now: '2026-10-09T17:00:00.000Z' });
  assert.equal(next.positions[0].last, 30);
  assert.equal(next.positions[0].marketValue, 300);
  assert.equal(next.optionPositions[0].estimatedValue, 0);
  assert.equal(next.pricesOk, true);
  assert.equal(next.asOf, book.asOf);
  assert.equal(next.totalValue, 400);
  assert.equal(holdingsFreshness(next, '2026-10-09').fresh, true);
  assert.equal(holdingsFreshness(next, '2026-10-09').stale, false);
});

test('a real symbol without a quote stays stale', () => {
  const next = applyHoldingQuotes(book, { TOST: { ok: false } }, { date: '2026-10-09', now: '2026-10-09T17:00:00.000Z' });
  assert.equal(next.pricesOk, false);
  assert.equal(holdingsFreshness(next, '2026-10-09').fresh, false);
});

test('an open option without a mark stays stale', () => {
  const open = {
    ...book,
    optionPositions: [{ symbol: 'KWEB', type: 'call', expiration: '2026-10-16', strike: 30, qty: 1, estimatedValue: 10 }]
  };
  const next = applyHoldingQuotes(open, { TOST: { ok: true, last: 30 } }, { date: '2026-10-09', now: '2026-10-09T17:00:00.000Z' });
  assert.equal(next.pricesOk, false);
  const marked = applyHoldingQuotes(open, { TOST: { ok: true, last: 30 } }, {
    date: '2026-10-09',
    now: '2026-10-09T17:00:00.000Z',
    optionMarks: { 'KWEB|2026-10-16|call|30': 1.5 }
  });
  assert.equal(marked.pricesOk, true);
  assert.equal(marked.optionPositions[0].estimatedValue, 150);
});
