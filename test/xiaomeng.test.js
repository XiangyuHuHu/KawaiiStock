import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_DESKS, paperDeskOf } from '../src/risk/limits.js';
import { xiaomengSessionDay } from '../src/paper/auto.js';
import {
  entrySetup,
  exitSetup,
  isStrongBar,
  sectorResonance,
  selectXiaomeng,
  sizeLimitPullback
} from '../src/paper/limit-pullback.js';

function day(n) {
  return new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10);
}

function bar(i, close, extra = {}) {
  return {
    date: day(i),
    open: extra.open ?? Number((close * 0.99).toFixed(4)),
    high: extra.high ?? Number((close * 1.01).toFixed(4)),
    low: extra.low ?? Number((close * 0.98).toFixed(4)),
    close,
    volume: extra.volume ?? 20_000_000
  };
}

function trend(n = 30, start = 10) {
  return Array.from({ length: n }, (_, i) => bar(i, Number((start + i * 0.08).toFixed(4))));
}

test('xiaomeng desks are their own 100k books', () => {
  assert.equal(paperDeskOf('0g'), '0g');
  assert.equal(paperDeskOf('paper-0h'), '0h');
  assert.equal(PAPER_DESKS['0g'].seed, 100_000);
  assert.equal(PAPER_DESKS['0h'].label.includes('小孟美股'), true);
});

test('A-share limit is 9.5% and a US 8% sealed day is the stand-in', () => {
  const prev = { close: 10 };
  const cn = { open: 10.2, high: 11, low: 10.1, close: 11 };
  const us = { open: 10.2, high: 10.85, low: 10.1, close: 10.85 };
  assert.equal(isStrongBar(cn, prev, '600000', 'cn'), true);
  assert.equal(isStrongBar(us, prev, '600000', 'cn'), false);
  assert.equal(isStrongBar(us, prev, 'NVDA', 'us'), true);
});

function pullbackBuy() {
  const bars = Array.from({ length: 28 }, (_, i) => bar(i, 10));
  bars.push(bar(28, 11, { open: 10.2, high: 11, low: 10.1 }));
  bars.push(bar(29, 10.2, { high: 10.4, low: 10.15 }));
  bars.push(bar(30, 10.55, { open: 10.25, high: 10.7, low: 10.2, volume: 40_000_000 }));
  return bars;
}

test('range-board pullback that reclaims the 5-day average is a buy', () => {
  const setup = entrySetup(pullbackBuy(), { symbol: '600000', market: 'cn', company: '测试' });
  assert.equal(setup.ok, true, setup.reason);
  assert.equal(setup.boards, 1);
  assert.equal(['ladder', 'range'].includes(setup.shape), true);
});

test('three boards, a pulse gap and a 16% pullback do not qualify', () => {
  const base = trend(24);
  const stamp = (close, i, extra) => bar(24 + i, close, extra);
  const prev = base.at(-1).close;
  const one = Number((prev * 1.1).toFixed(4));
  const two = Number((one * 1.1).toFixed(4));
  const three = Number((two * 1.1).toFixed(4));
  const chain = [
    ...base,
    stamp(one, 0, { open: Number((prev * 1.02).toFixed(4)), high: one, low: Number((prev * 1.01).toFixed(4)) }),
    stamp(two, 1, { open: Number((one * 1.02).toFixed(4)), high: two, low: Number((one * 1.01).toFixed(4)) }),
    stamp(three, 2, { open: Number((two * 1.02).toFixed(4)), high: three, low: Number((two * 1.01).toFixed(4)) }),
    stamp(Number((three * 0.98).toFixed(4)), 3)
  ];
  assert.equal(entrySetup(chain, { symbol: '600000', market: 'cn' }).reason, '三板及以上，不做');

  const pulse = trend(28);
  const was = pulse.at(-1).close;
  const sealed = Number((was * 1.1).toFixed(4));
  pulse.push(bar(28, sealed, { open: Number((was * 1.08).toFixed(4)), high: sealed, low: Number((was * 1.07).toFixed(4)) }));
  pulse.push(bar(29, Number((sealed * 0.98).toFixed(4))));
  pulse.push(bar(30, Number((sealed * 0.99).toFixed(4)), { volume: 40_000_000 }));
  assert.equal(entrySetup(pulse, { symbol: '600000', market: 'cn' }).ok, false);

  const deep = trend(28);
  const before = deep.at(-1).close;
  const board = Number((before * 1.1).toFixed(4));
  deep.push(bar(28, board, { open: Number((before * 1.02).toFixed(4)), high: board, low: Number((before * 1.01).toFixed(4)) }));
  const crushed = Number((board * 0.84).toFixed(4));
  deep.push(bar(29, crushed));
  deep.push(bar(30, Number((crushed * 1.02).toFixed(4)), { volume: 40_000_000 }));
  const deepSetup = entrySetup(deep, { symbol: '600000', market: 'cn' });
  assert.equal(deepSetup.ok, false);
  assert.match(deepSetup.reason, /跌破 10 日线|回调超过 15%/);
});

test('sector needs three recent boards and a 3% prior-day list gain', () => {
  const lists = { AAA: ['芯片'], BBB: ['芯片'], CCC: ['芯片'], DDD: ['其他'] };
  const members = { 芯片: ['AAA', 'BBB', 'CCC'], 其他: ['DDD'] };
  const mk = (lastGain, boardGain) => {
    const bars = trend(10, 20);
    const prev = bars.at(-1).close;
    const board = Number((prev * boardGain).toFixed(4));
    bars.push(bar(10, board, { open: Number((prev * 1.02).toFixed(4)), high: board, low: Number((prev * 1.01).toFixed(4)) }));
    bars.push(bar(11, Number((board * lastGain).toFixed(4))));
    return bars;
  };
  const barsBySymbol = {
    AAA: mk(0.99, 1.1),
    BBB: mk(0.99, 1.1),
    CCC: mk(0.99, 1.1),
    DDD: trend(12, 20)
  };
  assert.equal(sectorResonance('AAA', { lists, members, barsBySymbol, market: 'cn' }).ok, true);
  assert.equal(sectorResonance('DDD', { lists, members, barsBySymbol, market: 'cn' }).ok, false);
});

test('10万资金按 3 只约 3 万、4 只约 2.3 万，A股按整手', () => {
  const three = sizeLimitPullback({ nav: 100000, cash: 100000, price: 10, lot: 100, positions: 0 });
  assert.equal(three.qty, 3000);
  assert.equal(three.stop, 9.4);
  const four = sizeLimitPullback({ nav: 100000, cash: 100000, price: 10, lot: 100, positions: 3 });
  assert.equal(four.qty, 2300);
  const tiny = sizeLimitPullback({ nav: 100000, cash: 9000, price: 10, lot: 100, positions: 0 });
  assert.equal(tiny, null);
});

test('exits follow 5%, 8%, 4%, 6% and the fifth session', () => {
  const bars = Array.from({ length: 12 }, (_, i) => bar(i, 10));
  const pos = { symbol: '600000', qty: 2000, avgCost: 10, entryDate: bars[10].date };
  bars[11] = bar(11, 10.5);
  assert.equal(exitSetup(pos, bars, { market: 'cn', lot: 100 }).reason, 'take5');
  bars[11] = bar(11, 10.8);
  assert.equal(exitSetup(pos, bars, { market: 'cn', lot: 100 }).reason, 'take8');
  const soft = Array.from({ length: 12 }, (_, i) => bar(i, 9.5));
  soft[11] = bar(11, 9.6);
  assert.equal(exitSetup({ ...pos, entryDate: soft[10].date }, soft, { market: 'cn', lot: 100 }).reason, 'stop4');
  const hard = Array.from({ length: 12 }, (_, i) => bar(i, 8));
  hard[11] = bar(11, 9.4);
  assert.equal(exitSetup({ ...pos, entryDate: hard[10].date }, hard, { market: 'cn', lot: 100 }).reason, 'stop6');
  const flat = Array.from({ length: 8 }, (_, i) => bar(i, 10));
  assert.equal(exitSetup({ ...pos, entryDate: flat[0].date }, flat, { market: 'cn', lot: 100 }).reason, 'day5');
});

test('select keeps a name only when float and sector also pass', () => {
  const bars = pullbackBuy();
  const peer = () => {
    const rows = Array.from({ length: 29 }, (_, i) => bar(i, 12));
    rows.push(bar(29, 13.2, { open: 12.2, high: 13.2, low: 12.1 }));
    rows.push(bar(30, 13.1));
    return rows;
  };
  const barsBySymbol = { AAA: bars, BBB: peer(), CCC: peer(), DDD: peer() };
  const lists = { AAA: ['芯片'], BBB: ['芯片'], CCC: ['芯片'], DDD: ['芯片'] };
  const members = { 芯片: ['AAA', 'BBB', 'CCC', 'DDD'] };
  const missing = selectXiaomeng({ market: 'cn', barsBySymbol, lists, members, caps: {}, companies: {} });
  assert.equal(missing.buys.length, 0);
  const picked = selectXiaomeng({
    market: 'cn',
    barsBySymbol,
    lists,
    members,
    caps: { AAA: 80e8, BBB: 80e8, CCC: 80e8, DDD: 80e8 },
    companies: { AAA: '甲' }
  });
  assert.equal(picked.buys.some((row) => row.symbol === 'AAA'), true);
});

test('0G uses the China date when the daily job passes the US date', () => {
  const clocks = { usToday: '2026-10-09', cnToday: '2026-10-10' };
  assert.equal(xiaomengSessionDay('0g', '2026-10-09', clocks), '2026-10-10');
  assert.equal(xiaomengSessionDay('0h', '2026-10-09', clocks), '2026-10-09');
  assert.equal(xiaomengSessionDay('0g', '2026-10-01', clocks), '2026-10-01');
});
