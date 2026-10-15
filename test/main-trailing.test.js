import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessHeartbeat } from '../src/bot/heartbeat.js';
import { OPTIONS_PREFILTER_DEFAULTS } from '../src/bot/options-prefilter.js';
import {
  assessMainTrailing,
  suggestMainPosition
} from '../src/bot/main-trailing.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-10-15T14:30:00.000Z';

async function fixture() {
  const text = await readFile(new URL('./fixtures/main-trailing-book.json', import.meta.url), 'utf8');
  return JSON.parse(text);
}

function rowOf(status, symbol) {
  return status.mainTrailing.positions.find((row) => row.symbol === symbol);
}

test('research defaults stay labeled and do not authorize live trading', async () => {
  const status = assessHeartbeat(await fixture(), null, { now: NOW });
  const trail = status.mainTrailing;
  assert.equal(trail.observationOnly, true);
  assert.equal(trail.liveTradingAuthority, false);
  assert.equal(trail.placesOrders, false);
  assert.equal(trail.autoTrim, false);
  assert.equal(trail.researchDefaults, true);
  assert.equal(trail.hwmMonitorOnly, true);
  assert.equal(trail.riskModeChangesAction, false);
  assert.equal(trail.params.referenceBook, '7811');
  assert.match(trail.params.accountSizeNote, /7811/);
  assert.doesNotMatch(trail.params.accountSizeNote, /10k-15k/);
  assert.equal(trail.params.liveTradingAuthority, false);
  assert.equal(trail.params.label, 'research-defaults');
  assert.equal(trail.ownerBot, 'Kawaii小胡');
  assert.equal(trail.operableByKawaiiMeigu, false);
  assert.equal(trail.autoTrade7811, false);
  assert.equal(trail.scope.equityBook, '7811');
  assert.equal(trail.scope.ownerBot, 'Kawaii小胡');
  assert.deepEqual(trail.scope.excluded, ['3469', '7983']);
  assert.equal(status.liveTrading, false);
  assert.equal(trail.positions.every((row) => row.orderQty == null && row.observationOnly === true), true);
});

test('fixture book computes R, unrealized R, the ATR trail, and theme weight', async () => {
  const status = assessHeartbeat(await fixture(), null, { now: NOW });
  const mu = rowOf(status, 'MU');
  const mrvl = rowOf(status, 'MRVL');
  const iren = rowOf(status, 'IREN');
  assert.equal(mu.r, 10);
  assert.equal(mu.unrealizedR, 3);
  assert.equal(mu.k, 2.5);
  assert.deepEqual(mu.kCompare, [2.5, 3]);
  assert.equal(mu.kSource, 'research-default');
  assert.equal(mu.rawTrail, 122);
  assert.equal(mu.suggestedTrailStop, 122);
  assert.equal(mu.suggestedAction, 'TRIM_50');
  assert.deepEqual(mu.referenceTrimPct, [0.4, 0.55]);
  assert.equal(mu.nameWeightPct, 26);
  assert.equal(mu.nameWeightAboveCap, true);
  assert.equal(mrvl.r, 10);
  assert.equal(mrvl.unrealizedR, 1);
  assert.equal(mrvl.suggestedTrailStop, 74.5);
  assert.equal(mrvl.suggestedAction, 'HOLD');
  assert.equal(iren.k, 3);
  assert.deepEqual(iren.kCompare, [3, 3.5]);
  assert.equal(iren.suggestedTrailStop, 55);
  assert.equal(iren.unrealizedR, -1);
  assert.equal(iren.suggestedAction, 'EXIT');
  assert.equal(iren.reason, 'invalidation-breach');
  assert.equal(iren.nameWeightAboveReference, false);
  assert.deepEqual(status.mainTrailing.actions, { IREN: 'EXIT', MRVL: 'HOLD', MU: 'TRIM_50' });
  assert.equal(status.mainTrailing.themeWeights.length, 1);
  assert.equal(status.mainTrailing.themeWeights[0].theme, 'ai-infra');
  assert.equal(status.mainTrailing.themeWeights[0].marketValue, 4200);
  assert.equal(status.mainTrailing.themeWeights[0].weightPct, 42);
  assert.equal(status.mainTrailing.themeWeights[0].aboveReference, true);
  assert.equal(status.mainTrailing.themeWeights[0].aboveUpperReference, false);
  assert.equal(status.mainTrailing.themeWeightSumPct, 42);
  assert.equal(status.mainTrailing.themeConcentrationReview, true);
  assert.equal(status.mainTrailing.themeWeightBasis, 'nav');
  assert.equal(status.mainTrailing.hwmDrawdownPct, 0);
  assert.equal(status.mainTrailing.hwmBand, '0-6');
  assert.equal(status.mainTrailing.riskMode, 'normal');
  assert.equal(status.mainTrailing.hwmFlowAdjusted, true);
});

test('trail k follows vol class, an explicit k, and never loosens', () => {
  const event = suggestMainPosition({
    symbol: 'IREN',
    qty: 10,
    last: 60,
    avgCost: 50,
    invalidation: 40,
    atr14: 6,
    peakClose: 70,
    theme: 'power',
    volClass: 'event',
    stop: 55
  });
  assert.equal(event.k, 3);
  assert.equal(event.rawTrail, 52);
  assert.equal(event.suggestedTrailStop, 55);
  assert.equal(event.suggestedAction, 'HOLD');
  const highVol = suggestMainPosition({ ...eventInput(), volClass: 'high-vol', stop: 40, last: 60 });
  assert.equal(highVol.k, 3);
  assert.deepEqual(highVol.kCompare, [3, 3.5]);
  assert.equal(highVol.suggestedTrailStop, 52);
  const explicit = suggestMainPosition({
    symbol: 'MU',
    qty: 20,
    last: 130,
    avgCost: 100,
    invalidation: 90,
    atr14: 4,
    peakClose: 132,
    theme: 'ai-infra',
    volClass: 'growth',
    stop: 90,
    k: 3
  });
  assert.equal(explicit.kSource, 'input');
  assert.equal(explicit.suggestedTrailStop, 120);
  assert.equal(explicit.suggestedAction, 'TRIM_50');
  const ignored = suggestMainPosition({ ...explicitInput(), k: 4 });
  assert.equal(ignored.k, 2.5);
  assert.equal(ignored.kIgnored, 'outside-2.5-3.5');
  assert.equal(ignored.suggestedTrailStop, 122);
  const ratcheted = suggestMainPosition({
    symbol: 'MRVL',
    qty: 15,
    last: 81,
    avgCost: 70,
    invalidation: 60,
    atr14: 3,
    peakClose: 82,
    theme: 'ai-infra',
    stop: 80
  });
  assert.equal(ratcheted.rawTrail, 74.5);
  assert.equal(ratcheted.suggestedTrailStop, 80);
  assert.equal(ratcheted.suggestedAction, 'HOLD');
});

function eventInput() {
  return {
    symbol: 'IREN',
    qty: 10,
    last: 60,
    avgCost: 50,
    invalidation: 40,
    atr14: 6,
    peakClose: 70,
    theme: 'power',
    volClass: 'event',
    stop: 55
  };
}

function explicitInput() {
  return {
    symbol: 'MU',
    qty: 20,
    last: 130,
    avgCost: 100,
    invalidation: 90,
    atr14: 4,
    peakClose: 132,
    theme: 'ai-infra',
    volClass: 'growth',
    stop: 90
  };
}

test('trim ladder, healthy-trend deferral, and stops outrank trims', () => {
  const at2 = suggestMainPosition({
    symbol: 'MU', qty: 10, last: 120, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 120, theme: 'ai-infra', stop: 90
  });
  assert.equal(at2.unrealizedR, 2);
  assert.equal(at2.suggestedAction, 'TRIM_25');
  assert.deepEqual(at2.referenceTrimPct, [0.2, 0.25]);
  const deferred = suggestMainPosition({ ...at2row(), trendHealthy: true });
  assert.equal(deferred.suggestedAction, 'HOLD');
  assert.equal(deferred.reason, '2r-deferred-trend-healthy');
  const hot = suggestMainPosition({ ...at2row(), trendHealthy: true, overheated: true });
  assert.equal(hot.suggestedAction, 'TRIM_25');
  const already = suggestMainPosition({ ...at2row(), trimmed2R: true });
  assert.equal(already.suggestedAction, 'HOLD');
  assert.equal(already.reason, '2r-already-trimmed');
  const second = suggestMainPosition({
    symbol: 'MU', qty: 10, last: 140, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 140, theme: 'ai-infra', stop: 90, trimmed2R: true
  });
  assert.equal(second.suggestedAction, 'TRIM_25');
  assert.equal(second.reason, '3r-second-tranche');
  assert.deepEqual(second.referenceTrimPct, [0.2, 0.3]);
  const trailExit = suggestMainPosition({
    symbol: 'MU', qty: 10, last: 129, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 140, theme: 'ai-infra', stop: 90
  });
  assert.equal(trailExit.suggestedTrailStop, 130);
  assert.equal(trailExit.suggestedAction, 'EXIT');
  assert.equal(trailExit.reason, 'atr-trail-breach');
  const stopped = suggestMainPosition({
    symbol: 'BE', qty: 4, last: 90, avgCost: 100, invalidation: 90,
    atr14: 3, peakClose: 110, theme: 'power', stop: 90
  });
  assert.equal(stopped.suggestedAction, 'EXIT');
  assert.equal(stopped.reason, 'invalidation-breach');
  const missingCore = suggestMainPosition({
    symbol: 'BE', qty: 4, last: 110, invalidation: 90, atr14: 3, peakClose: 110, theme: 'power'
  });
  assert.equal(missingCore.suggestedAction, 'NO_TRADE');
  assert.equal(missingCore.orderQty, null);
  assert.ok(missingCore.missing.includes('avgCost'));
  const missingAtr = suggestMainPosition({
    symbol: 'MU', qty: 10, last: 140, avgCost: 100, invalidation: 90, peakClose: 140, theme: 'ai-infra', stop: 90
  });
  assert.equal(missingAtr.suggestedAction, 'TRIM_50');
  assert.equal(missingAtr.suggestedTrailStop, null);
  assert.deepEqual(missingAtr.missing, ['atr14']);
});

function at2row() {
  return {
    symbol: 'MU', qty: 10, last: 125, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 125, theme: 'ai-infra', stop: 90
  };
}

test('rebuy needs trend, breakout, or panic recovery', () => {
  const downOnly = suggestMainPosition({
    symbol: 'RKLB', qty: 0, last: 80, avgCost: 100, invalidation: 90,
    atr14: 5, peakClose: 120, theme: 'space', rebuy: 'down-20'
  });
  assert.equal(downOnly.suggestedAction, 'NO_TRADE');
  assert.equal(downOnly.reason, 'rebuy-down-20-alone');
  assert.equal(downOnly.orderQty, null);
  const dropField = suggestMainPosition({
    symbol: 'RKLB', qty: 0, last: 80, dropFromExitPct: -25, theme: 'space'
  });
  assert.equal(dropField.reason, 'rebuy-down-20-alone');
  const trend = suggestMainPosition({
    symbol: 'RKLB', qty: 0, last: 80, dropFromExitPct: -25, rebuy: 'trend', theme: 'space'
  });
  assert.equal(trend.suggestedAction, 'REBUY_1_3');
  assert.equal(trend.setup, 'trend');
  assert.equal(trend.referenceTranche, '1/3');
  assert.equal(trend.orderQty, null);
  const breakout = suggestMainPosition({ symbol: 'ASTS', qty: 0, setup: 'base-breakout', theme: 'space' });
  assert.equal(breakout.suggestedAction, 'REBUY_1_3');
  assert.equal(breakout.setup, 'breakout');
  const panic = suggestMainPosition({
    symbol: 'ASTS', qty: 0, rebuy: 'panic-recovery', rebuyTranche: 2, theme: 'space'
  });
  assert.equal(panic.suggestedAction, 'REBUY_ADD');
  assert.equal(panic.setup, 'panic-recovery');
  const addWithoutSetup = suggestMainPosition({ symbol: 'ASTS', qty: 0, rebuy: 'down-20', rebuyAdd: true });
  assert.equal(addWithoutSetup.suggestedAction, 'NO_TRADE');
  const held = suggestMainPosition({
    symbol: 'MU', qty: 10, last: 105, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 110, theme: 'ai-infra', stop: 90, rebuy: 'trend'
  });
  assert.equal(held.suggestedAction, 'HOLD');
});

test('high-water bands are monitor-only hints', () => {
  const cases = [
    [10000, 10000, 0, '0-6', 'normal'],
    [9401, 10000, 5.99, '0-6', 'normal'],
    [9400, 10000, 6, '6-10', 'reduce'],
    [9000, 10000, 10, '10-15', 'reduce'],
    [8501, 10000, 14.99, '10-15', 'reduce'],
    [8500, 10000, 15, '15+', 'contract']
  ];
  for (const [nav, hwmNav, drawdown, band, mode] of cases) {
    const status = assessMainTrailing({
      account: 'main',
      nav,
      hwmNav,
      positions: [{
        symbol: 'MU', qty: 1, last: 105, avgCost: 100, invalidation: 90,
        atr14: 4, peakClose: 110, theme: 'ai-infra', stop: 90
      }]
    });
    assert.equal(status.hwmDrawdownPct, drawdown, `${nav}`);
    assert.equal(status.hwmBand, band, `${nav}`);
    assert.equal(status.riskMode, mode, `${nav}`);
    assert.equal(status.actions.MU, 'HOLD');
  }
  const rebuyInDrawdown = assessMainTrailing({
    account: '7811',
    nav: 8400,
    hwmNav: 10000,
    positions: [{ symbol: 'RKLB', qty: 0, rebuy: 'panic-recovery', theme: 'space' }]
  });
  assert.equal(rebuyInDrawdown.riskMode, 'contract');
  assert.equal(rebuyInDrawdown.actions.RKLB, 'REBUY_1_3');
});

test('price wiggles stay silent, while an action change, a new -7% alert, or the fingerprint wakes', async () => {
  const book = await fixture();
  const first = assessHeartbeat(book, null, { now: NOW });
  assert.equal(first.no_change, false);
  assert.ok(first.wakes.some((row) => row.code === 'fingerprint'));
  const wiggle = structuredClone(book);
  wiggle.positions[1].last = 81;
  const quiet = assessHeartbeat(wiggle, first, { now: NOW });
  assert.equal(quiet.fingerprint, first.fingerprint);
  assert.equal(quiet.mainTrailing.actions.MRVL, 'HOLD');
  assert.notEqual(rowOf(quiet, 'MRVL').unrealizedR, rowOf(first, 'MRVL').unrealizedR);
  assert.equal(quiet.no_change, true);
  assert.equal(quiet.silent, true);
  assert.match(quiet.reason, /观察动作码也没变/);
  assert.deepEqual(quiet.wakes, []);
  const higherPeak = structuredClone(book);
  higherPeak.positions[1].peakClose = 84;
  const trailOnly = assessHeartbeat(higherPeak, first, { now: NOW });
  assert.equal(rowOf(trailOnly, 'MRVL').suggestedTrailStop, 76.5);
  assert.equal(trailOnly.no_change, true);
  const crossed = structuredClone(book);
  crossed.positions[1].last = 95;
  const woke = assessHeartbeat(crossed, first, { now: NOW });
  assert.equal(woke.fingerprint_unchanged, true);
  assert.deepEqual(woke.new_alerts, []);
  assert.equal(woke.mainTrailing.actions.MRVL, 'TRIM_25');
  assert.equal(woke.no_change, false);
  assert.deepEqual(woke.wakes.map((row) => row.code), ['trailing-action']);
  assert.equal(woke.wakes[0].from, 'HOLD');
  assert.equal(woke.wakes[0].to, 'TRIM_25');
  const hwmOnly = structuredClone(book);
  hwmOnly.hwmNav = 11200;
  const modeOnly = assessHeartbeat(hwmOnly, first, { now: NOW });
  assert.equal(modeOnly.mainTrailing.riskMode, 'reduce');
  assert.equal(modeOnly.mainTrailing.hwmBand, '10-15');
  assert.equal(modeOnly.no_change, true);
  const alerted = structuredClone(book);
  alerted.positions[1].changePct = -7.5;
  const dropped = assessHeartbeat(alerted, first, { now: NOW });
  assert.equal(dropped.fingerprint_unchanged, true);
  assert.deepEqual(dropped.new_alerts, ['MRVL']);
  assert.equal(dropped.mainTrailing.actions.MRVL, 'HOLD');
  assert.equal(dropped.no_change, false);
  const repeated = assessHeartbeat(alerted, dropped, { now: NOW });
  assert.equal(repeated.no_change, true);
  const sized = structuredClone(book);
  sized.positions[0].qty = 21;
  const fingerprint = assessHeartbeat(sized, first, { now: NOW });
  assert.equal(fingerprint.mainTrailing.actions.MU, 'TRIM_50');
  assert.ok(fingerprint.wakes.some((row) => row.code === 'fingerprint'));
  assert.equal(fingerprint.wakes.some((row) => row.code === 'trailing-action'), false);
});

test('7983 never receives main trailing, and a cost-only midday book stays on the old path', () => {
  const rich = {
    symbol: 'NVDA', qty: 10, last: 180, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 180, theme: 'ai-infra', stop: 170
  };
  const blocked = assessHeartbeat({
    account: 'main',
    accountLast4: '7983',
    routine: 'main-trailing',
    nav: 10000,
    positions: [rich]
  }, null, { now: NOW });
  assert.equal(blocked.mainTrailing, null);
  const optionsRoutine = assessHeartbeat({
    routine: 'midday-7983',
    nav: 10000,
    positions: [rich]
  }, null, { now: NOW });
  assert.equal(optionsRoutine.mainTrailing, null);
  const costOnly = assessHeartbeat({
    routine: 'midday',
    nav: 10000,
    positions: [{ symbol: 'MU', qty: 5, last: 90, avgCost: 100, stop: 80 }]
  }, null, { now: NOW });
  assert.equal(costOnly.mainTrailing, null);
  assert.ok(costOnly.new_alerts.includes('MU'));
  const shaped = assessHeartbeat({ nav: 10000, positions: [rich] }, null, { now: NOW });
  assert.equal(shaped.mainTrailing.actions.NVDA, 'TRIM_50');
  const tactical = assessHeartbeat({
    account: 'tactical',
    accountLast4: '3469',
    routine: 'main-trailing',
    nav: 11000,
    positions: [rich]
  }, null, { now: NOW });
  assert.equal(tactical.mainTrailing, null);
  const book3469 = assessHeartbeat({ accountLast4: '3469', nav: 11000, hwmNav: 11000, positions: [rich] }, null, { now: NOW });
  assert.equal(book3469.mainTrailing, null);
});

test('cli main-trailing exits 10 when the action changes and 0 on a price wiggle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'main-trail-'));
  const out = join(root, 'state.json');
  const input = join(root, 'in.json');
  const book = await fixture();
  await writeFile(input, JSON.stringify(book));
  const run = () => spawnSync(process.execPath, [
    'scripts/bot-heartbeat.js',
    '--input', input,
    '--routine', 'main-trailing',
    '--out', out,
    '--exit-code'
  ], { cwd: ROOT, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 10, first.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.mainTrailing.observationOnly, true);
  assert.equal(parsed.mainTrailing.placesOrders, false);
  assert.equal(parsed.mainTrailing.positions.every((row) => row.orderQty == null), true);
  book.positions[1].last = 81;
  await writeFile(input, JSON.stringify(book));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const quiet = JSON.parse(second.stdout);
  assert.equal(quiet.no_change, true);
  assert.equal(quiet.mainTrailing.actions.MRVL, 'HOLD');
  book.positions[1].last = 95;
  await writeFile(input, JSON.stringify(book));
  const third = run();
  assert.equal(third.status, 10, third.stderr);
  const woke = JSON.parse(third.stdout);
  assert.equal(woke.mainTrailing.actions.MRVL, 'TRIM_25');
  await rm(root, { recursive: true, force: true });
});

async function screenshot() {
  const text = await readFile(new URL('./fixtures/positions-2026-10-15.json', import.meta.url), 'utf8');
  return JSON.parse(text);
}

function family(status, name) {
  return status.themeFamilies.find((row) => row.family === name);
}

test('2026-10-15 Self-Directed 7811 screenshot treats JPMPD as cash and scores cost concentration', async () => {
  const book = await screenshot();
  assert.equal(book.ownerBot, 'Kawaii小胡');
  assert.equal(book.operableByKawaiiMeigu, false);
  const status = assessMainTrailing(book);
  assert.equal(status.ownerBot, 'Kawaii小胡');
  assert.equal(status.operableByKawaiiMeigu, false);
  assert.equal(status.autoTrade7811, false);
  assert.equal(status.placesOrders, false);
  assert.equal(status.cashUsd, 50098.32);
  assert.equal(status.cashWithdrawable, true);
  assert.deepEqual(status.cashSymbols, ['JPMPD']);
  assert.equal(status.cashReconciled, true);
  assert.equal(status.equityCostBasisUsd, 655193.39);
  assert.equal(status.equityCostBasisReconciled, true);
  assert.equal(status.capitalAtCostUsd, 705291.71);
  assert.equal(status.themeWeightBasis, 'cost');
  assert.equal(status.positions.some((row) => row.symbol === 'JPMPD'), false);
  assert.equal(status.positions.length, 14);
  assert.equal(status.positions.every((row) => row.suggestedAction === 'NO_TRADE' && row.orderQty == null && row.last == null), true);
  assert.ok(status.positions.every((row) => row.missing.includes('last')));
  const mu = status.positions.find((row) => row.symbol === 'MU');
  assert.equal(mu.nameWeightBasis, 'cost');
  assert.equal(mu.nameWeightPct, 11.67);
  assert.equal(mu.nameWeightAboveReference, true);
  assert.equal(mu.nameWeightAboveCap, false);
  const rklb = status.positions.find((row) => row.symbol === 'RKLB');
  assert.equal(rklb.volClass, 'event');
  assert.equal(rklb.nameWeightPct, 10.4797);
  assert.deepEqual(rklb.nameWeightReferencePct, [4, 8]);
  assert.equal(rklb.nameWeightAboveCap, true);
  assert.equal(family(status, 'semi').weightPct, 32.721);
  assert.equal(family(status, 'semi').heavy, true);
  assert.equal(family(status, 'semi').aboveReference, false);
  assert.equal(family(status, 'ai-power').weightPct, 25.6407);
  assert.equal(family(status, 'ai-power').weightPctOfCapital, 23.8194);
  assert.equal(family(status, 'cyber').weightPct, 12.6056);
  assert.equal(family(status, 'ai-linked').weightPct, 75.3155);
  assert.equal(family(status, 'ai-linked').aboveUpperReference, true);
  assert.equal(family(status, 'ai-linked').weightPctOfCapital, 69.9657);
  assert.equal(status.themeConcentrationReview, true);
  const folded = structuredClone(book);
  delete folded.cashUsd;
  folded.positions = [...folded.cashEquivalents, ...folded.positions];
  delete folded.cashEquivalents;
  const fromPosition = assessMainTrailing(folded);
  assert.equal(fromPosition.cashUsd, 50098.32);
  assert.equal(fromPosition.positions.some((row) => row.symbol === 'JPMPD'), false);
  assert.equal(fromPosition.equityCostBasisUsd, 655193.39);
  const quoted = structuredClone(book);
  const muRow = quoted.positions.find((row) => row.symbol === 'MU');
  muRow.last = 728.202;
  muRow.prev = 728.202;
  muRow.invalidation = 650;
  muRow.atr14 = 20;
  muRow.peakClose = 730;
  muRow.stop = 650;
  const hinted = assessMainTrailing(quoted);
  const hintedMu = hinted.positions.find((row) => row.symbol === 'MU');
  assert.equal(hintedMu.r, 78.202);
  assert.equal(hintedMu.unrealizedR, 0);
  assert.equal(hintedMu.suggestedTrailStop, 680);
  assert.equal(hintedMu.suggestedAction, 'HOLD');
  assert.equal(hinted.positions.filter((row) => row.symbol !== 'MU').every((row) => row.suggestedAction === 'NO_TRADE' && row.last == null), true);
  assert.equal(hinted.themeWeightBasis, 'cost');
});

test('7983 prefilter defaults and the 3469/7983 fill map stay unchanged', async () => {
  assert.deepEqual(OPTIONS_PREFILTER_DEFAULTS, {
    minDte: 2,
    maxDte: 14,
    minAbsDelta: 0.15,
    maxAbsDelta: 0.55,
    maxPremium: 5
  });
  const sim = await readFile(new URL('../src/sim.js', import.meta.url), 'utf8');
  const review = await readFile(new URL('../src/review.js', import.meta.url), 'utf8');
  const prefilter = await readFile(new URL('../src/bot/options-prefilter.js', import.meta.url), 'utf8');
  for (const source of [sim, review]) {
    assert.match(source, /key === '7983'\) return 'agentic'/);
    assert.match(source, /key === '3469'\) return 'tactical'/);
  }
  assert.match(prefilter, /0DTE\/1DTE 不会进入候选/);
  assert.match(prefilter, /short-dated-blocked/);
  assert.equal(prefilter.includes('TRIM_25'), false);
  const cli = await readFile(new URL('../scripts/bot-heartbeat.js', import.meta.url), 'utf8');
  assert.match(cli, /data\/bot\/heartbeat\.json/);
  assert.match(cli, /data\/bot\/main-trailing\.json/);
});
