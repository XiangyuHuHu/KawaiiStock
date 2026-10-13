import test from 'node:test';
import assert from 'node:assert/strict';
import { chandelierStop, closedBars, holdRankable, momentumExit, momentumSignal, momentumStop, momentumUniverse, rankMomentum, regimeOn, sizeMomentum } from '../src/paper/momentum.js';
import { paperDeskOf, PAPER_DESKS } from '../src/risk/limits.js';
import { entryBlocker, setEarningsSoon } from '../src/recommend.js';
import { simSettleDate } from '../src/daily.js';

test('daily sim settles the last closed session, not the open day', () => {
  const opening = new Date('2026-09-30T14:00:00Z');
  assert.equal(simSettleDate('2026-09-30', opening), '2026-09-29');
  const closed = new Date('2026-09-30T21:00:00Z');
  assert.equal(simSettleDate('2026-09-30', closed), '2026-09-30');
  assert.equal(simSettleDate('2026-10-05', new Date('2026-10-05T14:00:00Z')), '2026-10-02');
});

function series(n, fn, volume = 2_000_000) {
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    const date = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume };
  });
}

test('0f is its own paper desk', () => {
  assert.equal(paperDeskOf('0f'), '0f');
  assert.equal(paperDeskOf('paper-0f'), '0f');
  assert.equal(PAPER_DESKS['0f'].seed, 100_000);
});

test('momentum signal ranks steady uptrends and rejects downtrends', () => {
  const up = series(260, (i) => 50 * Math.exp(0.002 * i + 0.01 * Math.sin(i)));
  const fast = series(260, (i) => 50 * Math.exp(0.003 * i + 0.01 * Math.sin(i)));
  const down = series(260, (i) => 100 * Math.exp(-0.002 * i));
  const s = { UP: momentumSignal(up), FAST: momentumSignal(fast), DOWN: momentumSignal(down) };
  assert.equal(s.UP.eligible, true);
  assert.equal(s.DOWN.eligible, false);
  const ranked = rankMomentum(s);
  assert.deepEqual(ranked.map((row) => row.symbol), ['FAST', 'UP']);
  assert.equal(momentumSignal(up.slice(0, 120)).ok, false);
  assert.equal(regimeOn(up, fast), true);
  assert.equal(regimeOn(up, down), false);
});

test('momentum universe drops leveraged ETFs; closed bars drop today', () => {
  assert.deepEqual(momentumUniverse(['nvda', 'TQQQ', 'NVDL', 'BRK.B', '']), ['NVDA', 'BRK.B']);
  assert.equal(closedBars([{ date: '2026-09-29' }, { date: '2026-09-30' }], '2026-09-30').length, 1);
});

test('held names stay rankable when extended past entry filters', () => {
  const sig = { ok: true, eligible: false, score: 2, reasons: ['离 50 日线超过 8 个 ATR'] };
  assert.equal(rankMomentum(holdRankable({ HOT: sig }))[0].symbol, 'HOT');
  assert.equal(Object.keys(holdRankable({ NEG: { ok: true, score: -1 } })).length, 0);
});

test('momentum exits: stop first, then trend, then rank', () => {
  const signal = { ok: true, last: 100, sma100: 90 };
  assert.equal(momentumExit({ last: 95, stop: 96, signal, rank: 1 }), 'stop');
  assert.equal(momentumExit({ last: 100, stop: 80, signal: { ok: true, last: 85, sma100: 90 }, rank: 1 }), 'trend');
  assert.equal(momentumExit({ last: 100, stop: 80, signal, rank: 25, keepRank: 20 }), 'rank');
  assert.equal(momentumExit({ last: 100, stop: 80, signal, rank: 5, keepRank: 20 }), null);
});

test('chandelier trails from highest close since entry; stop clamps 4%-15%', () => {
  const bars = [{ date: '2026-09-01', close: 100 }, { date: '2026-09-02', close: 120 }, { date: '2026-09-03', close: 110 }];
  assert.equal(chandelierStop(bars, '2026-09-02', 5, 3), 105);
  assert.equal(chandelierStop(bars, '2026-09-03', 5, 3), 95);
  assert.equal(momentumStop(100, 1, 3), 96);
  assert.equal(momentumStop(100, 10, 3), 85);
  assert.equal(momentumStop(100, 3, 3), 91);
});

test('momentum sizing: 1% risk, 12.5% name cap, cash floor', () => {
  assert.deepEqual(sizeMomentum({ nav: 100000, cash: 100000, price: 100, stop: 90 }), { qty: 100, maxLoss: 1000, notional: 10000 });
  assert.equal(sizeMomentum({ nav: 100000, cash: 100000, price: 100, stop: 99 }).qty, 125);
  assert.equal(sizeMomentum({ nav: 100000, cash: 5000, price: 100, stop: 90 }), null);
});

test('recommendation BUY blocked by stop distance, chase and earnings', () => {
  setEarningsSoon(new Map([['ERN', '2026-10-01']]));
  assert.match(entryBlocker('ERN', 100, 95, 1), /财报/);
  assert.match(entryBlocker('A', 94, 95, 1), /止损下方/);
  assert.match(entryBlocker('A', 100, 99.5, 1), /1\.5%/);
  assert.match(entryBlocker('A', 100, 85, 1), /10%/);
  assert.match(entryBlocker('A', 100, 95, 7), /不追/);
  assert.equal(entryBlocker('A', 100, 95, 2), null);
  setEarningsSoon(new Map());
});
