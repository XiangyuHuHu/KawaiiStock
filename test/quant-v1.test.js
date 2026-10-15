import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessHeartbeat } from '../src/bot/heartbeat.js';
import { suggestMainPosition } from '../src/bot/main-trailing.js';
import { buildDecisionCard } from '../src/quant/decision-card.js';
import { completedWeeklyBars } from '../src/quant/mtf.js';
import { applyQuantPaperTick, seedOwnerPaperBook } from '../src/quant/paper-book.js';
import { classifyRegime, classifyStage } from '../src/quant/regime.js';
import { evaluateReentry } from '../src/quant/reentry.js';

const NOW = '2026-10-15T20:00:00.000Z';

function dates(n, { dropLast = 0 } = {}) {
  const out = [];
  const cursor = new Date(Date.UTC(2024, 0, 1));
  while (out.length < n + dropLast) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.slice(0, n);
}

function barsFrom(closes, { range = 1 } = {}) {
  return closes.map((close, index) => ({
    date: dates(closes.length)[index],
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 1_000_000
  }));
}

async function snapshot() {
  return JSON.parse(await readFile(new URL('./fixtures/positions-2026-10-15.json', import.meta.url), 'utf8'));
}

test('regime state machine picks a playbook and does not sell on extension alone', () => {
  const up = {
    close: 120, ema20: 110, ema50: 100, ema200: 90, adx14: 30, atr14: 4,
    lastTrueRange: 3, atrRatio: 1, rising20: true, high20: 121, low20: 100
  };
  assert.equal(classifyRegime(up).regime, 'StrongTrend');
  assert.equal(classifyRegime(up).playbook, 'trend-follow');
  assert.equal(classifyStage({ ...up, extension: 2.5, rising60: true }, 'StrongTrend').stage, '主升');
  assert.equal(classifyStage({ ...up, extension: 0.4, adx14: 24, rising60: false }, 'StrongTrend').stage, '启动');
  assert.equal(classifyStage({ ...up, extension: 3.4, structureBreak: false }, 'StrongTrend').stage, '衰竭');
  const down = {
    close: 80, ema20: 90, ema50: 100, ema200: 110, adx14: 25, atr14: 4,
    lastTrueRange: 3, atrRatio: 1, falling20: true, low20: 79, high20: 95
  };
  assert.equal(classifyRegime(down).regime, 'DownTrend');
  assert.equal(classifyRegime(down).playbook, 'defend');
  const range = {
    close: 100, ema20: 101, ema50: 99, ema200: 98, adx14: 12, atr14: 2,
    lastTrueRange: 1.2, atrRatio: 1, rising20: false, falling20: false, high20: 110, low20: 90
  };
  assert.equal(classifyRegime(range).regime, 'Range');
  assert.equal(classifyRegime(range).playbook, 'mean-revert');
  assert.equal(classifyRegime({ ...up, lastTrueRange: 20, atr14: 4 }).regime, 'HighVolEvent');
  assert.equal(classifyRegime({ ...up, lastTrueRange: 20, atr14: 4 }).playbook, 'defend');
  assert.equal(classifyRegime({ close: 10, atr14: null }).regime, 'unknown');
});

test('incomplete weekly bars are dropped and do not confirm a buy', () => {
  const daily = barsFrom(Array.from({ length: 8 }, (_, i) => 100 + i));
  const weekly = completedWeeklyBars(daily);
  assert.equal(weekly.incompleteWeeklyDropped, true);
  assert.equal(weekly.bars.length, 1);
  assert.equal(weekly.bars[0].date.endsWith('05') || new Date(`${weekly.bars[0].date}T00:00:00Z`).getUTCDay() === 5, true);
  const partial = barsFrom(Array.from({ length: 98 }, (_, i) => 100 + i * 0.4), { range: 2 });
  const card = buildDecisionCard({ symbol: 'MU', bars: partial, position: { symbol: 'MU', qty: 0 } });
  assert.equal(card.mtf.incompleteWeeklyDropped, true);
  assert.equal(card.mtf.weekly, 'unavailable');
  assert.equal(card.mtf.confirmed, false);
});

test('giveback, RSI, and extension do not sell; exhaustion can tighten the high-vol trail', () => {
  const held = {
    symbol: 'MU', qty: 10, last: 105, avgCost: 100, invalidation: 90,
    atr14: 4, peakClose: 110, theme: 'ai-memory', stop: 90, rsi: 88, extended: true, upTooMuch: true
  };
  const calm = suggestMainPosition(held);
  assert.equal(calm.suggestedAction, 'HOLD');
  assert.equal(calm.givebackPct, 50);
  assert.equal(calm.givebackChangesAction, false);
  assert.equal(calm.rsiIgnored, true);
  assert.equal(calm.extensionIgnored, true);
  const highVol = {
    symbol: 'IREN', qty: 10, last: 54, avgCost: 50, invalidation: 40,
    atr14: 6, peakClose: 70, theme: 'crypto-ai-power', volClass: 'high-vol', stop: 40
  };
  const wide = suggestMainPosition(highVol);
  assert.equal(wide.k, 3);
  assert.deepEqual(wide.kVariants, [2.5, 3, 3.5, 4]);
  assert.equal(wide.suggestedTrailStop, 52);
  assert.equal(wide.suggestedAction, 'HOLD');
  const explicit = suggestMainPosition({ ...highVol, k: 4, last: 60, stop: 40 });
  assert.equal(explicit.k, 4);
  assert.equal(explicit.kSource, 'input');
  assert.equal(explicit.rawTrail, 46);
  const tightened = suggestMainPosition({ ...highVol, structureBreak: true });
  assert.equal(tightened.kTightened, 2.5);
  assert.equal(tightened.tightenReason, 'structure-break');
  assert.equal(tightened.suggestedTrailStop, 55);
  assert.equal(tightened.suggestedAction, 'EXIT');
  assert.equal(tightened.reason, 'atr-trail-tightened');
  assert.equal(tightened.givebackChangesAction, false);
});

test('re-entry allows pullback, base breakout, and RS recovery, never a 20% dip alone', () => {
  const dip = evaluateReentry({
    qty: 0, last: 80, dropFromExitPct: -25, regime: 'StrongTrend', playbook: 'trend-follow', mtfConfirmed: true
  });
  assert.equal(dip.allowed, false);
  assert.equal(dip.action, 'NO_TRADE');
  assert.equal(dip.reason, 'rebuy-down-20-alone');
  const pullback = evaluateReentry({
    qty: 0, last: 101, ema20: 100, atr14: 4, regime: 'StrongTrend', playbook: 'trend-follow', mtfConfirmed: true
  });
  assert.equal(pullback.allowed, true);
  assert.equal(pullback.setup, 'pullback-to-ema');
  assert.equal(pullback.action, 'REBUY_1_3');
  const unconfirmed = evaluateReentry({ ...pullback, mtfConfirmed: false, qty: 0, last: 101, ema20: 100, atr14: 4, regime: 'StrongTrend', playbook: 'trend-follow' });
  assert.equal(unconfirmed.reason, 'mtf-unconfirmed');
  const breakout = evaluateReentry({
    qty: 0, last: 103, baseHigh: 100, ema20: 80, atr14: 2,
    regime: 'StrongTrend', playbook: 'trend-follow', mtfConfirmed: true
  });
  assert.equal(breakout.setup, 'breakout-of-base');
  const recovered = evaluateReentry({
    qty: 0, last: 130, ema20: 100, atr14: 2, rs20: 0.04, rs20Prev: -0.01,
    regime: 'Range', playbook: 'mean-revert', mtfConfirmed: true
  });
  assert.equal(recovered.setup, 'rs-recovery');
  const blocked = evaluateReentry({
    qty: 0, last: 103, baseHigh: 100, ema20: 80, atr14: 2,
    regime: 'Range', playbook: 'defend', mtfConfirmed: true
  });
  assert.equal(blocked.reason, 'regime-defend');
  const riskOff = evaluateReentry({
    qty: 0, last: 101, ema20: 100, atr14: 4, regime: 'StrongTrend', playbook: 'trend-follow',
    mtfConfirmed: true, addsBlocked: true
  });
  assert.equal(riskOff.reason, 'breadth-risk-off');
});

test('decision card shape stays explainable and cannot place an order', () => {
  const closes = Array.from({ length: 130 }, (_, i) => 80 + i * 0.35);
  const card = buildDecisionCard({
    symbol: 'MRVL',
    bars: barsFrom(closes, { range: 2 }),
    spyBars: barsFrom(closes.map((close) => close * 0.5), { range: 1 }),
    position: {
      symbol: 'MRVL', qty: 10, avgCost: 100, invalidation: 90, atr14: 4,
      peakClose: 110, last: 105, theme: 'ai-semiconductor', stop: 90, rsi: 75
    }
  });
  for (const key of ['regime', 'playbook', 'stage', 'scores', 'suggestedAction', 'trailingStop', 'reentryTrigger', 'reasons', 'mtf', 'relativeStrength']) {
    assert.ok(key in card, key);
  }
  assert.equal(card.version, 'kawaii-quant-v1');
  assert.equal(card.liveTrading, false);
  assert.equal(card.autoTrade7811, false);
  assert.equal(card.placesOrders, false);
  assert.equal(card.orderQty, null);
  assert.equal(card.researchDefaults, true);
  assert.ok(['HOLD', 'TRIM', 'EXIT', 'REBUY', 'NO_TRADE'].includes(card.suggestedAction));
  assert.equal(typeof card.scores.trend === 'number' || card.scores.trend == null, true);
  assert.ok(Array.isArray(card.reasons) && card.reasons.length >= 3);
  assert.match(card.reentryTrigger, /20%/);
  assert.equal(card.givebackChangesAction, false);
  assert.equal(card.rsiIgnored, true);
  assert.equal(card.relativeStrength.benchmark, 'SPY');
  assert.equal(card.relativeStrength.sector, 'SMH');
});

test('7811 holdings seed a paper book and one TRIM then one EXIT stay off the broker', async () => {
  const book = seedOwnerPaperBook(await snapshot());
  assert.match(book.label, /真实持仓/);
  assert.match(book.label, /7811/);
  assert.equal(book.cash, 50098.32);
  assert.equal(book.positions.length, 14);
  assert.equal(book.positions.some((row) => row.symbol === 'JPMPD'), false);
  assert.equal(book.liveTrading, false);
  assert.equal(book.autoTrade7811, false);
  assert.equal(book.placesOrders, false);
  assert.equal(book.brokerOrders, false);
  assert.equal(book.orderQty, null);
  assert.equal(book.driver, 'kawaii-quant-v1');
  assert.equal(book.fills.length, 0);

  const trimBook = structuredClone(book);
  const mu = trimBook.positions.find((row) => row.symbol === 'MU');
  mu.invalidation = 700;
  mu.atr14 = 8;
  mu.peakClose = 790;
  mu.last = 790;
  const trimmed = applyQuantPaperTick(trimBook, { asOf: '2026-10-16', prices: { MU: 790 } });
  const trimFill = trimmed.fills.find((row) => row.symbol === 'MU');
  assert.equal(trimFill.action, 'TRIM');
  assert.equal(trimFill.qty, 21);
  assert.equal(trimFill.price, 790);
  assert.equal(trimFill.broker, false);
  assert.equal(trimmed.positions.find((row) => row.symbol === 'MU').qty, 84);
  assert.equal(trimmed.cash, 66688.32);
  assert.equal(trimmed.liveTrading, false);
  assert.equal(trimmed.autoTrade7811, false);
  const again = applyQuantPaperTick(trimmed, { asOf: '2026-10-17', prices: { MU: 790 } });
  assert.equal(again.fills.length, 1);
  assert.ok(again.peakPnl >= again.pnl);

  const exitBook = structuredClone(book);
  const exiting = exitBook.positions.find((row) => row.symbol === 'MU');
  exiting.invalidation = 700;
  exiting.atr14 = 8;
  exiting.peakClose = 790;
  const exited = applyQuantPaperTick(exitBook, { asOf: '2026-10-16', prices: { MU: 690 } });
  const exitFill = exited.fills.find((row) => row.symbol === 'MU');
  assert.equal(exitFill.action, 'EXIT');
  assert.equal(exitFill.qty, 105);
  assert.equal(exitFill.broker, false);
  assert.equal(exitFill.placesOrders, false);
  assert.equal(exited.positions.some((row) => row.symbol === 'MU'), false);
  assert.equal(exited.cash, 122548.32);
  assert.equal(exited.exits.MU.sellReason, 'invalidation-breach');
  assert.equal(exited.autoTrade7811, false);

  const dipBook = structuredClone(book);
  const rklb = dipBook.positions.find((row) => row.symbol === 'RKLB');
  dipBook.positions = dipBook.positions.filter((row) => row.symbol !== 'RKLB');
  dipBook.exits.RKLB = {
    symbol: 'RKLB', soldQty: rklb.qty, planQty: rklb.qty, lastExitPrice: 100,
    tranches: 0, theme: rklb.theme, volClass: rklb.volClass
  };
  const dipped = applyQuantPaperTick(dipBook, { asOf: '2026-10-16', prices: { RKLB: 80 } });
  assert.equal(dipped.fills.some((row) => row.action === 'REBUY'), false);
  assert.equal(dipped.positions.some((row) => row.symbol === 'RKLB'), false);

  const status = assessHeartbeat({
    routine: 'midday',
    nav: 10,
    positions: [{ symbol: 'AAA', qty: 1, last: 10, stop: 9 }],
    quantPaper: true,
    quantPaperSnapshot: await snapshot()
  }, null, { now: NOW });
  assert.equal(status.liveTrading, false);
  assert.equal(status.quantPaper.autoTrade7811, false);
  assert.equal(status.quantPaper.placesOrders, false);
  assert.equal(status.quantPaper.cash, 50098.32);
  assert.equal(status.quantPaper.fills.length, 0);
});
