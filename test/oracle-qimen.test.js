import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionOpenMs } from '../src/market-time.js';
import {
  hmOffsetMs,
  windowMs,
  scoreExpect,
  scoreFirstDipThenRise,
  judgeReading,
  buildOracleDesk,
  SPX_2026_09_16
} from '../src/oracle/qimen.js';

const day = '2026-09-16';
const open = sessionOpenMs(day);

function bar(offsetMin, px, extra = {}) {
  const ts = open + offsetMin * 60000;
  return {
    date: new Date(ts).toISOString(),
    ts,
    open: extra.open ?? px,
    high: extra.high ?? px + 0.15,
    low: extra.low ?? px - 0.15,
    close: extra.close ?? px,
    volume: 1
  };
}

function path(points) {
  return Array.from({length: 78}, (_, i) => {
    const min = i * 5;
    const left = points.findLast(p => p[0] <= min);
    const right = points.find(p => p[0] > min) || left;
    const px = right === left ? left[1] : left[1] + (right[1] - left[1]) * (min - left[0]) / (right[0] - left[0]);
    return bar(min, px);
  });
}

test('session windows map 9:30–16:00 ET onto the cash open', () => {
  assert.equal(hmOffsetMs('09:30'), 0);
  assert.equal(hmOffsetMs('10:10'), 40 * 60000);
  const win = windowMs(day, '09:30', '10:10');
  assert.equal(win.start, open);
  assert.equal(win.end - win.start, 40 * 60000);
});

test('chop vs dip-then-up vs rally scoring stays closed without bars', () => {
  assert.equal(scoreExpect('chop', null).grade, 'pending');
  const chop = { open: 100, close: 100.05, high: 100.4, low: 99.7, net: 0.0005, range: 0.007, minIdx: 2, maxIdx: 4, n: 8 };
  assert.equal(scoreExpect('chop', chop).grade, 'hit');
  const dip = { open: 100, close: 100.3, high: 100.4, low: 99.6, net: 0.003, range: 0.008, minIdx: 1, maxIdx: 7, n: 10 };
  assert.equal(scoreExpect('dip-then-up', dip).grade, 'hit');
  const rally = { open: 100, close: 100.4, high: 100.5, low: 99.95, net: 0.004, range: 0.0055, minIdx: 0, maxIdx: 6, n: 8 };
  assert.equal(scoreExpect('rally', rally).grade, 'hit');
});

test('first-dip-then-rise needs the low before the high', () => {
  assert.equal(scoreFirstDipThenRise({ n: 20, minIdx: 4, maxIdx: 14, open: 100, close: 100.2 }).grade, 'hit');
  assert.equal(scoreFirstDipThenRise({ n: 20, minIdx: 16, maxIdx: 3, open: 100, close: 100.2 }).grade, 'miss');
});

test('seeded SPX reading grades a matching 先抑后扬 session and does not emit orders', () => {
  const bars = path([
    [0, 100], [10, 99.9], [20, 99.7], [35, 99.85],
    [50, 99.4], [70, 99.8], [90, 100.3], [110, 100.2],
    [140, 100.05], [165, 99.95], [190, 100.1],
    [230, 100.35], [270, 100.55], [310, 100.4],
    [340, 100.38], [370, 100.32], [385, 100.28]
  ]);
  const close = windowMs(day, '15:00', '16:00').end;
  const pack = judgeReading(SPX_2026_09_16, { bars, now: close + 1000, source: 'test', last: 100.28 });
  assert.equal(pack.liveTrading, false);
  assert.equal(pack.phases.length, 5);
  assert.ok(pack.phases.every((row) => row.grade !== 'pending'));
  assert.equal(pack.overall.first.grade, 'hit');
  assert.equal(pack.overall.bias.grade, 'hit');
  assert.match(pack.overall.headline, /收盘对照/);
  assert.equal(pack.instrument.symbol, 'SPY');
});

test('missing bars stay pending and never invent a buy', () => {
  const pack = judgeReading(SPX_2026_09_16, { bars: [], now: open - 3600000 });
  assert.equal(pack.liveTrading, false);
  assert.ok(pack.phases.every((row) => row.grade === 'pending'));
  assert.equal(pack.overall.current, null);
});

test('incomplete live phases and sparse historical bars never count as completed hits', () => {
  const bars=path([[0,100],[385,101]]);
  const live=judgeReading(SPX_2026_09_16,{bars,now:open+20*60000});
  assert.equal(live.phases[0].status,'live');
  assert.equal(live.overall.scored,0);
  assert.equal(live.overall.first.grade,'pending');
  const sparse=judgeReading(SPX_2026_09_16,{bars:bars.filter((_,i)=>i%3===0),now:open+400*60000});
  assert.equal(sparse.overall.scored,0);
  assert.equal(sparse.overall.bias.grade,'pending');
  assert.equal(sparse.session.coverage.missing,52);
});

test('duplicates, malformed and unaligned bars cannot fill a coverage gap', () => {
  const bars=path([[0,100],[385,101]]);
  const bad=[...bars.slice(1),bars[1],{...bars[0],high:0},{...bars[0],ts:bars[0].ts+1}];
  const p=judgeReading(SPX_2026_09_16,{bars:bad,now:open+400*60000});
  assert.equal(p.session.barCount,77);
  assert.equal(p.phases[0].grade,'pending');
  assert.equal(p.overall.scored,4);
  assert.equal(p.overall.first.grade,'pending');
  assert.equal(p.provenance.recordedAt,null);
});

test('invalid windows and phases after early close are unavailable', () => {
  assert.equal(hmOffsetMs('25:99'),null);
  assert.equal(windowMs(day,'10:10','09:30'),null);
  assert.equal(windowMs(day,'09:31','10:10'),null);
  assert.equal(windowMs('2026-11-27','13:15','15:00'),null);
  const early='2026-11-27', start=sessionOpenMs(early);
  const bars=Array.from({length:42},(_,i)=>({...bar(i*5,100),ts:start+i*300000}));
  const p=judgeReading({...SPX_2026_09_16,date:early},{bars,now:start+220*60000});
  assert.equal(p.session.coverage.complete,true);
  assert.equal(p.phases[3].status,'unavailable');
  assert.equal(p.session.coverage.expected,42);
});

test('sampled backup prices and provider errors retain the reading without fabricated grades', async () => {
  const sampled=await buildOracleDesk({date:day,loader:async()=>({ok:true,source:'nasdaq',bars:path([[0,100],[385,101]])})});
  assert.equal(sampled.overall.scored,0);
  assert.match(sampled.session.error,/采样价格/);
  const failed=await buildOracleDesk({date:day,loader:async()=>{throw Error('upstream unavailable');}});
  assert.equal(failed.date,day);
  assert.equal(failed.session.barCount,0);
  assert.match(failed.session.error,/upstream unavailable/);
});
