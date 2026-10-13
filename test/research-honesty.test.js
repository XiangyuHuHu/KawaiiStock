import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustCyclicalValuation, anomalyFromMargin, fundamentalsStale } from '../src/valuation-guards.js';
import { briefUpstreamStatus, composeAgenticBrief } from '../src/agentic-brief.js';
import { rankOptionPool } from '../src/options/engine.js';
import { classifyBars, gateCrossbackBreak, primaryBlockReason } from '../src/strategy/cycle.js';
import { cnCheapCard } from '../src/strategy/watchlist-cn.js';
import { calendarCacheFresh } from '../src/events.js';
import { accountReturn } from '../src/sim.js';
import { priceConflict, rememberTape, resetTape } from '../src/tape.js';

test('cyclical names use mid-cycle EPS and a DCF blend when forward EPS dwarfs TTM', () => {
  const out = adjustCyclicalValuation({
    symbol: 'MU',
    sector: 'Technology',
    ttmEps: 8,
    forwardEps: 176,
    earningsMultiple: 25.7,
    dcfValue: 400,
    fairValue: 4520
  });
  assert.equal(out.kind, 'semi-memory');
  assert.ok(out.fairValue < 2000);
  assert.equal(out.dcfWeight, 50);
  assert.equal(out.confidence, 'Low');
  assert.ok(out.fwdToTtm > 2);
});

test('margin of safety above 100% is a model anomaly and drops the opportunity score', () => {
  const anomaly = anomalyFromMargin(357);
  assert.equal(anomaly.modelAnomaly, true);
  assert.equal(anomaly.status, 'Model anomaly');
  assert.equal(anomaly.opportunityScore, null);
  assert.equal(anomalyFromMargin(40).modelAnomaly, false);
});

test('fundamentals older than 30 days or already past earnings are stale', () => {
  const now = new Date('2026-10-13T16:00:00Z');
  const old = fundamentalsStale({ fiscalDate: '2026-09-03', now });
  assert.equal(old.stale, true);
  assert.match(old.reasons[0], /30 天/);
  const earned = fundamentalsStale({ fiscalDate: '2026-10-01', earningsDate: '2026-10-10', now });
  assert.equal(earned.stale, true);
  assert.match(earned.reasons.join(' '), /财报日/);
  const fresh = fundamentalsStale({ fiscalDate: '2026-10-01', earningsDate: '2026-10-20', now });
  assert.equal(fresh.stale, false);
});

test('agentic votes cover the full list scan and flag a newer upstream file', () => {
  const brief = composeAgenticBrief({
    date: '2026-10-13',
    now: new Date('2026-10-13T18:00:00Z'),
    watch: {
      ok: true,
      date: '2026-10-13',
      generatedAt: '2026-10-13T15:00:00Z',
      scanned: 3,
      regime: 'risk-on',
      universeSnapshot: {
        rows: [
          { symbol: 'AAA', stage: 'base-n-break', score: 10 },
          { symbol: 'BBB', stage: 'wedge-drop', score: 10 },
          { symbol: 'CCC', stage: 'ema-crossback', score: 10 }
        ]
      },
      boards: {},
      featured: { up: [], down: [] }
    },
    options: { ok: true, date: '2026-10-13', generatedAt: '2026-10-13T14:00:00Z', scanned: 0, ideas: [], buys: [] },
    recs: { date: '2026-10-13', generatedAt: '2026-10-13T14:00:00Z', accounts: [{ id: 'agentic', priorities: [], recommendations: [], opportunities: [] }] },
    holdings: { asOf: '2026-10-13', positions: [] }
  });
  assert.deepEqual(brief.votes.map((row) => row.symbol).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(brief.sources.watch.voteScope, 'full-scan');
  assert.equal(brief.sources.options.emptyScan, true);
  const status = briefUpstreamStatus(brief, {
    watch: { generatedAt: '2026-10-13T19:00:00Z', scanned: 90 },
    options: { generatedAt: '2026-10-13T14:00:00Z', scanned: 0 }
  });
  assert.equal(status.upstreamStale, true);
  assert.match(status.upstreamNotes.join(' '), /每日观察/);
});

test('a blocked buy names one reason instead of a score-only gate', () => {
  const reason = primaryBlockReason({
    ok: true,
    allowNewLong: false,
    stage: 'ema-crossback',
    stageLabel: 'EMA Crossback',
    score: 88,
    confirmation: { confirmed: false, reasons: ['没有新突破 / 回踩收复确认', '分数 88 低于 80'] }
  });
  assert.equal(reason, '没有新突破 / 回踩收复确认');
});

test('option pool ranks holdings and option flow ahead of list order', () => {
  const rows = [
    { symbol: 'AAA', from: 'watchlist-fallback' },
    { symbol: 'BBB', from: 'watchlist-fallback' },
    { symbol: 'NVDA', from: 'watchlist-fallback' },
    { symbol: 'TSLA', from: 'holdings' }
  ];
  const ranked = rankOptionPool(rows, {
    BBB: { optionVolume: 10, openInterest: 10 },
    NVDA: { optionVolume: 5000, openInterest: 8000 }
  });
  assert.equal(ranked[0].symbol, 'TSLA');
  assert.equal(ranked[1].symbol, 'NVDA');
  assert.notEqual(ranked[2].symbol, 'AAA');
});

test('price above EMA50 is not a wedge drop, and a broken crossback waits', () => {
  const bars = [];
  for (let i = 0; i < 80; i += 1) {
    const close = 100 + i * 0.8;
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    bars.push({ date: day, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 });
  }
  const last = bars.at(-1);
  last.high = last.close + 4;
  last.close = last.open - 0.1;
  const cycle = classifyBars(bars, { version: 'v1' });
  assert.notEqual(cycle.stage, 'wedge-drop');
  const gated = gateCrossbackBreak({
    stage: 'ema-crossback',
    last: 90,
    atr: 2,
    ema10: 100,
    allowNewLong: true,
    watch: true,
    tradeable: true,
    note: 'EMA Crossback'
  }, [{ close: 100 }, { close: 90 }]);
  assert.equal(gated.pendingConfirm, true);
  assert.equal(gated.allowNewLong, false);
  assert.equal(gated.pendingConfirmLabel, '今日跌破，待确认');
});

test('low PE board is neutral and does not call the weakest name strongest', () => {
  const card = cnCheapCard({ symbol: '002364', company: '中恒电气', changePct: -6, pe: 8, turnover: 2, lists: [] });
  assert.equal(card.side, 'neutral');
  assert.equal(card.stageLabel, '低PE');
  assert.match(card.thesis, /不是当日最强/);
  assert.doesNotMatch(card.thesis, /最强，不是目标价/);
});

test('a partial earnings cache is not fresh, and null capital is not 0%', () => {
  const now = Date.parse('2026-10-13T16:00:00Z');
  const datesFetched = Array.from({ length: 10 }, (_, i) => {
    const utc = new Date(Date.UTC(2026, 9, 13 + i));
    return utc.toISOString().slice(0, 10);
  });
  assert.equal(calendarCacheFresh({
    from: '2026-10-13',
    days: 10,
    fetchedAt: '2026-10-13T15:00:00Z',
    datesFetched,
    rows: [{ symbol: 'AAPL', date: '2026-10-14' }],
    errors: [{ date: '2026-10-14', error: 'earnings 500' }]
  }, '2026-10-13', 10, now), false);
  assert.equal(calendarCacheFresh({
    from: '2026-10-13',
    days: 10,
    fetchedAt: '2026-10-13T15:00:00Z',
    rows: [{ symbol: 'AAPL', date: '10/14/2025' }],
    errors: []
  }, '2026-10-13', 10, now), false);
  assert.equal(calendarCacheFresh({
    from: '2026-10-13',
    days: 10,
    fetchedAt: '2026-10-13T15:00:00Z',
    datesFetched,
    rows: [{ symbol: 'AAPL', date: '2026-10-14' }],
    errors: []
  }, '2026-10-13', 10, now), true);
  const missing = accountReturn({ startingNav: null, pnl: 0 }, null);
  assert.equal(missing.returnStatus, 'not-configured');
  assert.equal(missing.pnlPct, null);
  const funded = accountReturn({ startingNav: 1000, pnl: 25 }, 1000);
  assert.equal(funded.pnlPct, 2.5);
});

test('shared tape flags two prices for the same symbol', () => {
  resetTape();
  rememberTape('NVDA', { last: 226.32, source: 'screener-quote' });
  const conflict = rememberTape('NVDA', { last: 224.59, source: 'cycle-close' });
  assert.equal(conflict.flag, 'price-conflict');
  assert.equal(priceConflict('NVDA', 224.59, 'cycle-close').other, 226.32);
  resetTape();
});
