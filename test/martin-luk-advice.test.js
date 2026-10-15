import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDecisionCard } from '../src/quant/decision-card.js';
import { classifyEmaStack } from '../src/martin/classify.js';
import { adrStopSoftCheck, assessStructure, marketRegimeHint } from '../src/martin/entry.js';
import {
  evaluateLeader,
  evaluatePotent,
  evaluatePremarket,
  sortByMonthPerformance,
  sortByPremarketChange
} from '../src/martin/filters.js';
import { MARTIN_SCAN_DEFAULTS, POST_FILL_STOP_ITEM } from '../src/martin/params.js';
import { buildAndWriteMartinAdvice, buildMartinAdvice, mergeScanUniverse } from '../src/martin/report.js';

const ACTIONS = new Set(['WATCH', 'BUY_REF', 'HOLD_REF', 'NO_TRADE']);

function dates(n) {
  const out = [];
  const cursor = new Date(Date.UTC(2024, 0, 2));
  while (out.length < n) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function barsFromCloses(closes, shape) {
  const ds = dates(closes.length);
  return closes.map((close, index) => {
    const extra = typeof shape === 'function' ? shape(close, index, closes) : shape;
    return {
      date: ds[index],
      open: close,
      high: extra.high,
      low: extra.low,
      close,
      volume: extra.volume ?? 2_000_000
    };
  });
}

function pullbackBars() {
  const closes = [];
  for (let i = 0; i < 77; i += 1) closes.push(40 + i * 0.9);
  const peak = closes[closes.length - 1];
  closes.push(peak - 2.2, peak - 3.1, peak - 2.4);
  return barsFromCloses(closes, (close) => ({ high: close * 1.05, low: close * 0.97 }));
}

function chaseBars() {
  const closes = Array.from({ length: 80 }, (_, index) => 40 + index * 0.9);
  return barsFromCloses(closes, (close) => ({ high: close * 1.02, low: close * 0.99 }));
}

function wideStopBars() {
  const closes = [];
  for (let i = 0; i < 77; i += 1) closes.push(40 + i * 0.9);
  const peak = closes[closes.length - 1];
  closes.push(peak - 1, peak - 1.5, peak - 1.2);
  return barsFromCloses(closes, (close, index) => ({
    high: close + 0.15,
    low: index === 78 ? close - 8 : close - 0.15
  }));
}

function decliningBars() {
  const closes = Array.from({ length: 80 }, (_, index) => 150 - index * 0.8);
  return barsFromCloses(closes, (close) => ({ high: close * 1.02, low: close * 0.98 }));
}

function indexBars(direction) {
  const closes = Array.from({ length: 80 }, (_, index) => (
    direction === 'down' ? 500 - index * 1.2 : 300 + index * 1.1
  ));
  return barsFromCloses(closes, (close) => ({ high: close + 1, low: close - 1, volume: 10_000_000 }));
}

const published = {
  marketCapUsd: 2_000_000_000,
  volatility1wPct: 4.2,
  close: 100,
  ema21: 92,
  volumeTimesPriceUsd: 60_000_000,
  avgVolume10d: 800_000,
  volumeTimesPrice1wUsd: 400_000_000,
  premarketChangePct: 2.5,
  performance1mPct: 18
};

test('scan defaults keep the published M2 thresholds and the pending-backtest label', () => {
  assert.equal(MARTIN_SCAN_DEFAULTS.label, '待回测');
  assert.equal(MARTIN_SCAN_DEFAULTS.potent.marketCapGtUsd, 100_000_000);
  assert.equal(MARTIN_SCAN_DEFAULTS.potent.volatility1wGtPct, 3.5);
  assert.equal(MARTIN_SCAN_DEFAULTS.potent.volumeTimesPriceGtUsd, 50_000_000);
  assert.equal(MARTIN_SCAN_DEFAULTS.premarket.avgVolume10dGtShares, 500_000);
  assert.equal(MARTIN_SCAN_DEFAULTS.leader.volumeTimesPrice1wGtUsd, 300_000_000);
});

test('potent, premarket, and leader filters use source fields and degrade without inventing them', () => {
  const potent = evaluatePotent(published);
  assert.equal(potent.pass, true);
  assert.equal(potent.strictPass, true);
  assert.equal(potent.checks.find((check) => check.id === 'volatility_1w').source_field, 'Volatility 1W');
  assert.equal(evaluatePotent({ ...published, close: 80 }).pass, false);
  assert.equal(evaluatePotent({ ...published, marketCapUsd: 100_000_000 }).pass, false);
  assert.equal(evaluatePotent({ ...published, volatility1wPct: 3.5 }).strictPass, false);

  const noPlatformVol = evaluatePotent({ ...published, volatility1wPct: undefined, adr20Pct: 20 });
  const volatility = noPlatformVol.checks.find((check) => check.id === 'volatility_1w');
  assert.equal(volatility.missing, true);
  assert.equal(volatility.value, null);
  assert.equal(volatility.pass, null);
  assert.equal(noPlatformVol.degraded, true);
  assert.equal(noPlatformVol.strictPass, false);

  const tinyLastBar = Array.from({ length: 12 }, (_, index) => ({
    close: 100,
    high: 101,
    low: 99,
    volume: index === 11 ? 100_000 : 5_000_000
  }));
  const notAverage = evaluatePotent({
    bars: tinyLastBar,
    marketCapUsd: 2_000_000_000,
    volatility1wPct: 5,
    ema21: 90
  });
  assert.equal(notAverage.pass, false);
  assert.equal(notAverage.checks.find((check) => check.id === 'volume_times_price').value, 10_000_000);

  const premarket = evaluatePremarket({ ...published, premarketChangePct: undefined });
  assert.equal(premarket.pass, true);
  assert.equal(premarket.premarketChangePct, null);
  assert.equal(premarket.premarketChangeMissing, true);

  assert.equal(evaluateLeader({ ...published, volumeTimesPrice1wUsd: 300_000_000 }).pass, false);
  assert.equal(evaluateLeader(published).pass, true);
  const proxy = evaluateLeader({ ...published, volumeTimesPrice1wUsd: undefined, bars: pullbackBars() });
  assert.equal(proxy.checks.find((check) => check.id === 'volume_times_price_1w').proxy, true);
  assert.equal(proxy.checks.find((check) => check.id === 'volume_times_price_1w').normalized_field, 'dollar_volume_sum_5d');

  const ranked = sortByPremarketChange([
    { symbol: 'AAA', premarketChangePct: 1 },
    { symbol: 'BBB', premarketChangePct: null },
    { symbol: 'CCC', premarketChangePct: 5.5 }
  ]);
  assert.deepEqual(ranked.map((row) => row.symbol), ['CCC', 'AAA', 'BBB']);
  assert.equal(ranked[2].premarketChangePct, null);
  const byMonth = sortByMonthPerformance([
    { symbol: 'DDD', performance1mPct: 1 },
    { symbol: 'EEE', performance1mPct: null },
    { symbol: 'FFF', performance1mPct: 9 }
  ]);
  assert.deepEqual(byMonth.map((row) => row.symbol), ['FFF', 'DDD', 'EEE']);
});

test('9/21/50 EMA classification is Lead, Mediocre, or Lag and is not an order', () => {
  assert.equal(classifyEmaStack(12, 10, 8).stage, 'LEAD');
  assert.equal(classifyEmaStack(10, 9, 12).stage, 'MEDIOCRE');
  assert.equal(classifyEmaStack(8, 10, 9).stage, 'MEDIOCRE');
  assert.equal(classifyEmaStack(8, 9, 10).stage, 'LAG');
  assert.equal(classifyEmaStack(null, 9, 10).stage, 'TRANSITION');
});

test('first healthy pullback can be BUY_REF, a fresh breakout stays WATCH, and a wide stop is not tightened', () => {
  const healthy = pullbackBars();
  const structure = assessStructure(healthy);
  assert.equal(structure.setup, 'FIRST_PULLBACK');
  assert.equal(structure.stage, 'LEAD');
  assert.equal(structure.planned_stop, Math.round(Math.min(...healthy.slice(-3).map((bar) => bar.low)) * 100) / 100);

  const report = buildMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'RISK_ON', notes: ['测试直接给定'] },
    rows: [
      { symbol: 'TEST', bars: healthy, onWatchlist: true },
      { symbol: 'CHASE', bars: chaseBars() },
      { symbol: 'WIDE', bars: wideStopBars() },
      { symbol: 'SINK', bars: decliningBars() },
      { symbol: 'SPY', bars: indexBars('up') }
    ]
  });
  const buy = report.candidates.find((row) => row.symbol === 'TEST');
  assert.equal(buy.action, 'BUY_REF');
  assert.equal(typeof buy.planned_stop, 'number');
  assert.ok(buy.planned_stop < buy.levels.close);
  assert.equal(buy.entryChecklist.adrSoftCheck.pass, true);
  assert.equal(buy.entryChecklist.preferFirstHealthyPullback, true);
  assert.match(buy.scan, /potent/);
  assert.equal(buy.premarketChangePct, null);
  assert.equal(buy.stopMustPlaceAfterFill, true);
  assert.match(buy.r_notes, /禁止事后倒推/);

  const chase = report.candidates.find((row) => row.symbol === 'CHASE');
  assert.equal(chase.entryChecklist.setup, 'BREAKOUT_EXTENDED');
  assert.equal(chase.action, 'WATCH');
  assert.notEqual(chase.action, 'BUY_REF');

  const wide = report.candidates.find((row) => row.symbol === 'WIDE');
  const wideBars = wideStopBars();
  const deepLow = Math.round(Math.min(...wideBars.slice(-3).map((bar) => bar.low)) * 100) / 100;
  assert.equal(wide.planned_stop, deepLow);
  assert.equal(wide.entryChecklist.adrSoftCheck.pass, false);
  assert.equal(wide.entryChecklist.adrSoftCheck.tightened, false);
  assert.equal(wide.entryChecklist.adrSoftCheck.widened, false);
  assert.notEqual(wide.action, 'BUY_REF');

  const sink = report.candidates.find((row) => row.symbol === 'SINK');
  assert.equal(sink.stage, 'LAG');
  assert.notEqual(sink.action, 'BUY_REF');
  assert.equal(report.candidates.some((row) => row.symbol === 'SPY'), false);

  const soft = adrStopSoftCheck({ entry: 100, plannedStop: 90, adrPct: 5 });
  assert.equal(soft.pass, false);
  assert.equal(soft.widened, false);
});

test('missing structure, small cap, risk-off, and existing holdings do not become suggested opens', () => {
  const short = buildMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'RISK_ON' },
    rows: [{ symbol: 'SHORT', bars: pullbackBars().slice(0, 10) }]
  }).candidates[0];
  assert.equal(short.planned_stop, null);
  assert.notEqual(short.action, 'BUY_REF');

  const small = buildMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'RISK_ON' },
    rows: [{ symbol: 'TINY', bars: pullbackBars(), marketCapUsd: 50_000_000 }]
  }).candidates[0];
  assert.equal(small.scan, null);
  assert.notEqual(small.action, 'BUY_REF');

  const riskOff = buildMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'RISK_OFF' },
    rows: [{ symbol: 'TEST', bars: pullbackBars() }]
  }).candidates[0];
  assert.equal(riskOff.action, 'WATCH');

  const held = buildMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'RISK_ON' },
    positions: [{ symbol: 'TEST', qty: 10 }],
    rows: [{ symbol: 'TEST', bars: pullbackBars() }]
  });
  assert.equal(held.candidates[0].action, 'HOLD_REF');
  assert.equal(held.candidates[0].stopMustPlaceAfterFill, false);
  assert.equal(held.stopChecklist.length, 0);

  const empty = buildMartinAdvice({ asOf: '2026-10-15', rows: [{ symbol: 'NONE' }] });
  assert.equal(empty.candidates[0].action, 'NO_TRADE');
  assert.equal(empty.candidates[0].planned_stop, null);
  assert.match(empty.candidates[0].reasons.join(' '), /不编造/);
});

test('daily report schema, post-fill checklist, and file artifact stay reference-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'martin-advice-'));
  const written = await buildAndWriteMartinAdvice({
    asOf: '2026-10-15',
    regime: { hint: 'NEUTRAL' },
    reportsDir: dir,
    rows: [{ symbol: 'TEST', bars: pullbackBars(), onWatchlist: true }]
  });
  const report = written.report;
  assert.equal(report.asOf, '2026-10-15');
  assert.equal(report.regime.hint, 'NEUTRAL');
  assert.equal(report.ownerBot, 'Kawaii小胡');
  assert.equal(report.audience, 'Kawaii美股');
  assert.equal(report.account7811, 'observation-paper');
  assert.equal(report.liveTrading, false);
  assert.equal(report.autoTrade7811, false);
  assert.equal(report.placesOrders, false);
  assert.equal(report.brokerOrders, false);
  assert.equal(report.optionsInScope, false);
  assert.equal(report.referenceOnly, true);
  assert.equal(report.brokerOrderId, null);
  assert.ok(Array.isArray(report.disclaimers) && report.disclaimers.length >= 5);
  assert.equal(report.stopChecklist.length, 1);
  assert.equal(report.stopChecklist[0].item, POST_FILL_STOP_ITEM);
  assert.equal(POST_FILL_STOP_ITEM, '成交后立刻挂 GTC stop');
  assert.equal(report.stopChecklist[0].stopMustPlaceAfterFill, true);
  assert.equal(report.stopChecklist[0].brokerOrderId, null);
  assert.equal(report.stopChecklist[0].planned_stop, report.candidates[0].planned_stop);
  for (const row of report.candidates) {
    assert.equal(ACTIONS.has(row.action), true);
    assert.equal(typeof row.symbol, 'string');
    assert.equal(typeof row.r_notes, 'string');
    assert.ok(Array.isArray(row.reasons));
    assert.ok('planned_stop' in row);
    assert.ok('scan' in row);
    assert.ok('stage' in row);
    if (row.action === 'BUY_REF') {
      assert.equal(typeof row.planned_stop, 'number');
      assert.equal(row.stopMustPlaceAfterFill, true);
    }
  }

  const raw = await readFile(written.jsonPath, 'utf8');
  const saved = JSON.parse(raw);
  assert.equal(saved.schema, 'martin-luk-advice-v1');
  assert.equal(saved.liveTrading, false);
  assert.equal(saved.stopChecklist[0].brokerOrderId, null);
  const markdown = await readFile(written.mdPath, 'utf8');
  assert.match(markdown, /成交后立刻挂 GTC stop/);
  assert.match(written.jsonPath, /2026-10-15-martin-luk-advice\.json$/);
  assert.match(written.mdPath, /2026-10-15-martin-luk-advice\.md$/);
});

test('regime hint follows SPY and QQQ together, and the scan list prefers the watchlist', () => {
  assert.equal(marketRegimeHint(indexBars('up'), indexBars('up')).hint, 'RISK_ON');
  assert.equal(marketRegimeHint(indexBars('down'), indexBars('down')).hint, 'RISK_OFF');
  assert.equal(marketRegimeHint(indexBars('up'), indexBars('down')).hint, 'NEUTRAL');
  assert.equal(marketRegimeHint(indexBars('up').slice(0, 10), indexBars('up')).hint, 'UNKNOWN');
  const merged = mergeScanUniverse(['ZZZ', 'SPY', 'AAPL'], ['MSFT', 'QQQ']);
  assert.equal(merged[0], 'ZZZ');
  assert.equal(merged.includes('SPY'), false);
  assert.equal(merged.includes('QQQ'), false);
  assert.ok(merged.includes('AAPL'));
  assert.ok(merged.includes('NVDA'));
  assert.ok(merged.length <= 36);
});

test('a Martin note on the decision card does not replace the V1 action or enable trading', () => {
  const closes = Array.from({ length: 130 }, (_, index) => 80 + index * 0.35);
  const bars = closes.map((close, index) => ({
    date: dates(closes.length)[index],
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000
  }));
  const plain = buildDecisionCard({
    symbol: 'MRVL',
    bars,
    position: { symbol: 'MRVL', qty: 10, avgCost: 100, last: 120 }
  });
  assert.equal('martin' in plain, false);
  assert.equal(plain.liveTrading, false);
  assert.equal(plain.orderQty, null);
  const card = buildDecisionCard({
    symbol: 'MRVL',
    bars,
    position: { symbol: 'MRVL', qty: 10, avgCost: 100, last: 120 },
    martin: { action: 'BUY_REF', stage: 'LEAD', scan: 'potent', planned_stop: 110 }
  });
  assert.equal(card.suggestedAction, plain.suggestedAction);
  assert.equal(card.orderQty, null);
  assert.equal(card.liveTrading, false);
  assert.equal(card.autoTrade7811, false);
  assert.equal(card.martin.action, 'BUY_REF');
  assert.equal(card.martin.replacesGates, false);
  assert.equal(card.martin.planned_stop, 110);
  assert.notEqual(card.suggestedAction, 'BUY_REF');
});
