import test from 'node:test';
import assert from 'node:assert/strict';
import { exitOnBar, validateWindow } from '../src/strategy/validation.js';

test('same bar stop and target => stop; gaps can lose more than 1R', () => {
  const p = { stop: 90, target: 120 };
  assert.equal(exitOnBar(p, { open: 100, high: 125, low: 85 }).reason, 'stop');
  assert.equal(exitOnBar(p, { open: 70, high: 95, low: 60 }).price, 70 * .9995);
});
test('validation is deterministic and never supplies future bars', () => {
  const bars = Array.from({ length: 85 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i, volume: 1e6 }));
  const dataset = { QQQ: { ok: true, bars }, TEST: { ok: true, bars } };
  const options = { start: bars[60].date, end: bars.at(-1).date, classifier: (history, { qqqBars }) => {
    assert.equal(history.at(-1).date, qqqBars.at(-1).date);
    return { allowNewLong: true, last: history.at(-1).close, stop: history.at(-1).close - 5, score: 80 };
  } };
  const a = validateWindow(dataset, options), b = validateWindow(dataset, options);
  assert.deepEqual(a, b);
  assert.ok(a.trades > 0);
  for (const trade of a.tradeDetails) assert.ok(trade.entryDate > trade.signalDate);
  assert.ok(a.curve.every((row) => row.cash >= 0 && row.positions <= 5));
});
