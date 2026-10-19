import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isChinaSessionDay } from '../src/paths.js';
import { paperExecution } from '../src/paper/execution.js';
import {
  chinaPaperSession,
  desksForSession,
  paperMarketOf,
  paperSessionOpen,
  regularPaperSession
} from '../src/paper/sessions.js';
import { daemonIntervalMin, nextSessionOpen } from '../src/paper/schedule.js';
import { buildDiagnostics } from '../src/paper/diagnostics.js';
import { formatPaperRunMarkdown, paperRunPayload } from '../src/paper/report.js';
import { paperDeskAudit } from '../src/paper/audit.js';
import {
  entrySetup,
  floatOk,
  isStrongBar,
  liveChase,
  microstructureGate,
  replayPullbackSignals,
  sectorResonance,
  US_PULLBACK,
  US_PULLBACK_V1
} from '../src/paper/limit-pullback.js';
import { parseCnSectorMarkdown, parseUsSectorMarkdown } from '../src/paper/xiaomeng-universe.js';

const cnOpen = Date.parse('2026-10-19T02:00:00Z');
const usOpen = Date.parse('2026-10-19T14:00:00Z');
const holiday = Date.parse('2026-10-01T02:00:00Z');
const sunday = Date.parse('2026-10-18T15:00:00Z');

function quote(now) {
  return { ok: true, last: 10, bid: 9.99, ask: 10.01, quoteAt: now };
}

test('A-share session is Shanghai morning and afternoon on a trading day', () => {
  assert.equal(isChinaSessionDay('2026-10-19'), true);
  assert.equal(isChinaSessionDay('2026-10-01'), false);
  assert.equal(isChinaSessionDay('2026-10-17'), false);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T01:30:00Z')), true);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T01:29:00Z')), false);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T03:29:00Z')), true);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T03:30:00Z')), false);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T04:00:00Z')), false);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T05:00:00Z')), true);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T06:59:00Z')), true);
  assert.equal(chinaPaperSession(Date.parse('2026-10-19T07:00:00Z')), false);
  assert.equal(chinaPaperSession(holiday), false);
  assert.equal(chinaPaperSession(sunday), false);
});

test('each desk uses its own market session', () => {
  assert.equal(regularPaperSession(cnOpen), false);
  assert.equal(regularPaperSession(usOpen), true);
  assert.equal(paperMarketOf('0g'), 'cn');
  assert.equal(paperMarketOf('0h'), 'us');
  assert.equal(paperSessionOpen('0g', cnOpen), true);
  assert.equal(paperSessionOpen('0a', cnOpen), false);
  assert.equal(paperSessionOpen('0h', usOpen), true);
  assert.equal(paperSessionOpen('0g', usOpen), false);
  const china = desksForSession(['0a', '0g', '0h'], cnOpen);
  assert.deepEqual(china.open, ['0g']);
  assert.deepEqual(china.closed, ['0a', '0h']);
  const ny = desksForSession(['0a', '0g', '0h'], usOpen);
  assert.deepEqual(ny.open, ['0a', '0h']);
  assert.deepEqual(ny.closed, ['0g']);
});

test('equity fills follow the order market, not a single US gate', () => {
  const cnOrder = { symbol: '300383', instrument: 'equity', side: 'buy', qty: 100, limitPrice: 10.05, desk: '0g' };
  const usOrder = { symbol: 'AAPL', instrument: 'equity', side: 'buy', qty: 1, limitPrice: 10.05, desk: '0h' };
  assert.equal(paperExecution(cnOrder, quote(cnOpen), cnOpen).ok, true);
  assert.equal(paperExecution(usOrder, quote(cnOpen), cnOpen).code, 'outside-session');
  assert.equal(paperExecution(usOrder, quote(usOpen), usOpen).ok, true);
  assert.equal(paperExecution(cnOrder, quote(usOpen), usOpen).code, 'outside-session');
  assert.equal(paperExecution(cnOrder, quote(holiday), holiday).code, 'outside-session');
  assert.equal(paperExecution({ ...usOrder, paperReference: true }, quote(cnOpen), cnOpen).ok, true);
});

test('US pullback thresholds are wider and missing depth is neutral', () => {
  const prev = { close: 10 };
  assert.equal(isStrongBar({ open: 10.1, high: 10.4, low: 10, close: 10.4 }, prev, 'AAA', 'us'), false);
  assert.equal(isStrongBar({ open: 10.1, high: 10.55, low: 10, close: 10.55 }, prev, 'AAA', 'us'), true);
  assert.equal(isStrongBar({ open: 10.2, high: 10.85, low: 10.1, close: 10.85 }, prev, 'NVDA', 'us', US_PULLBACK_V1), true);
  assert.equal(floatOk(8e9, 'us').ok, true);
  assert.equal(floatOk(0.3e9, 'us').ok, false);
  assert.equal(floatOk(30e9, 'us').ok, false);
  assert.equal(floatOk(8e9, 'us', US_PULLBACK_V1).ok, false);
  assert.equal(floatOk(80e8, 'cn').ok, true);
  assert.equal(microstructureGate(null, US_PULLBACK).ok, true);
  assert.equal(microstructureGate(null, US_PULLBACK).neutral, true);
  assert.equal(microstructureGate(null, { ...US_PULLBACK_V1, missingMicrostructure: 'fail' }).ok, false);
  assert.equal(liveChase({ market: 'us', symbol: 'AAA', changePct: 5.2, last: 10.5, high: 10.52 }), true);
  assert.equal(liveChase({ market: 'us', symbol: 'AAA', changePct: 2 }), false);
  assert.equal(liveChase({ market: 'cn', symbol: '600000', changePct: 9.9, last: 11, high: 11 }), true);
  assert.equal(liveChase({ market: 'cn', symbol: '300383', changePct: 6, last: 10.6, high: 11 }), false);
});

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

function usPullback() {
  const bars = Array.from({ length: 28 }, (_, i) => bar(i, 10));
  bars.push(bar(28, 10.6, { open: 10.15, high: 10.6, low: 10.05 }));
  bars.push(bar(29, 10.1, { open: 10.4, high: 10.3, low: 10.05 }));
  bars.push(bar(30, 10.35, { open: 10.1, high: 10.5, low: 10.05, volume: 40_000_000 }));
  return bars;
}

function peerBoard() {
  const rows = Array.from({ length: 29 }, (_, i) => bar(i, 12));
  rows.push(bar(29, 12.72, { open: 12.15, high: 12.72, low: 12.05 }));
  rows.push(bar(30, 12.7));
  return rows;
}

test('US v2 buys the first dip that stays above the 5-day average', () => {
  const bars = Array.from({ length: 28 }, (_, i) => bar(i, 10));
  bars.push(bar(28, 10.6, { open: 10.15, high: 10.6, low: 10.05 }));
  bars.push(bar(29, 10.45, { open: 10.55, high: 10.5, low: 10.4, volume: 12_000_000 }));
  const held = entrySetup(bars, { symbol: 'PATH', market: 'us' });
  assert.equal(held.ok, true, held.reason);
  assert.equal(held.reason, '回撤守住 5 日线');
  const crossOnly = entrySetup(bars, { symbol: 'PATH', market: 'us', rules: US_PULLBACK_V1 });
  assert.equal(crossOnly.ok, false);
  bars.push(bar(30, 10.42, { open: 10.44, high: 10.48, low: 10.38 }));
  assert.equal(entrySetup(bars, { symbol: 'PATH', market: 'us' }).ok, false);
});

test('two co-moving US names can pass v2 and still fail the old 8% / 3-name rule', () => {
  const lists = { AAA: ['半导体'], BBB: ['半导体'], CCC: ['半导体'] };
  const members = { 半导体: ['AAA', 'BBB', 'CCC'] };
  const barsBySymbol = { AAA: usPullback(), BBB: peerBoard(), CCC: peerBoard() };
  assert.equal(sectorResonance('AAA', { lists, members, barsBySymbol, market: 'us' }).ok, true);
  assert.equal(sectorResonance('AAA', { lists, members, barsBySymbol, market: 'us', rules: US_PULLBACK_V1 }).ok, false);
  const caps = { AAA: 8e9, BBB: 8e9, CCC: 8e9 };
  const v2 = replayPullbackSignals({ market: 'us', barsBySymbol, lists, members, caps, rules: US_PULLBACK });
  const v1 = replayPullbackSignals({ market: 'us', barsBySymbol, lists, members, caps, rules: US_PULLBACK_V1 });
  assert.equal(v1.signals, 0);
  assert.ok(v2.signals >= 1, JSON.stringify(v2));
});

test('maintained A-share universe is mid-cap sectors, not the three mega names', async () => {
  const content = await readFile(new URL('../lists/cn/小孟中小盘.md', import.meta.url), 'utf8');
  const lists = parseCnSectorMarkdown(content);
  const symbols = lists.flatMap((list) => list.stocks.map((row) => row.symbol));
  assert.ok(lists.length >= 5);
  assert.ok(symbols.length >= 40);
  assert.equal(new Set(symbols).size, symbols.length);
  for (const banned of ['600519', '300750', '000001']) assert.equal(symbols.includes(banned), false, banned);
  const us = parseUsSectorMarkdown(await readFile(new URL('../lists/us/小孟美股.md', import.meta.url), 'utf8'));
  assert.ok(us.length >= 4);
  assert.ok(us.reduce((sum, list) => sum + list.symbols.length, 0) >= 20);
});

test('diagnostics count scans, filter reasons and placed orders', () => {
  const diag = buildDiagnostics({
    desk: '0g',
    scan: { scanned: 12, eligible: 1, rejections: { '日线不足': 8, '流通市值不在 50–200 亿区间': 1 } },
    fills: [{ ok: true, replay: false, symbol: '300383', side: 'buy', qty: 100, price: 10 }, { ok: true, replay: true, symbol: '300383', side: 'buy' }],
    skipped: [{ reason: 'size' }]
  });
  assert.equal(diag.market, 'cn');
  assert.equal(diag.scanned, 12);
  assert.equal(diag.ordersPlaced, 1);
  assert.equal(diag.filterRejections['日线不足'], 8);
  assert.equal(diag.skipRejections.size, 1);
  const payload = paperRunPayload({
    outsideSession: false,
    markets: { cn: true, us: false },
    note: '测试',
    sessions: { '0g': { desk: '0g', diagnostics: diag, note: '测试', ok: true } }
  }, cnOpen);
  const md = formatPaperRunMarkdown(payload);
  assert.match(md, /0g/);
  assert.match(md, /日线不足/);
  assert.match(md, /liveTrading: false/);
});

test('desk audit names the two repaired books and the intentional option freeze', () => {
  const rows = Object.fromEntries(paperDeskAudit().map((row) => [row.id, row]));
  assert.equal(Object.keys(rows).length, 8);
  assert.equal(rows['0g'].market, 'cn');
  assert.equal(rows['0h'].market, 'us');
  assert.match(rows['0g'].status, /已修/);
  assert.match(rows['0h'].note, /5%/);
  assert.match(rows['0e'].status, /不开新仓/);
  assert.equal(rows['0f'].status, '可跑');
});

test('daemon waits for the next open and clamps the interval', () => {
  assert.equal(daemonIntervalMin(undefined), 20);
  assert.equal(daemonIntervalMin(1), 5);
  assert.equal(daemonIntervalMin(90), 60);
  const next = nextSessionOpen(sunday);
  assert.ok(next > sunday);
  assert.equal(chinaPaperSession(next) || regularPaperSession(next), true);
});

test('a closed clock writes a per-desk report and does not trade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-session-'));
  const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { runPaperOpen } from './src/paper/auto.js';
    const now = Date.parse('2026-10-18T15:00:00Z');
    const result = await runPaperOpen({ now, desk: 'all' });
    assert.equal(result.liveTrading, false);
    assert.equal(result.outsideSession, true);
    assert.equal(result.sessions['0g'].diagnostics.ordersPlaced, 0);
    assert.equal(result.sessions['0g'].diagnostics.skipRejections['outside-session'], 1);
    assert.equal(result.sessions['0h'].diagnostics.market, 'us');
    assert.equal(result.sessions['0a'].diagnostics.market, 'us');
    const text = await readFile(join(process.env.KAWAII_REPORTS_DIR, '2026-10-18-纸上实验.md'), 'utf8');
    assert.match(text, /0g/);
    assert.match(text, /outside-session|不在/);
    console.log('session-report-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'),
      KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_PAPER: join(dir, 'paper'),
      OBSIDIAN_VAULT: join(dir, 'vault'),
      OBSIDIAN_LISTS: join(dir, 'lists'),
      OBSIDIAN_CN_LISTS: join(dir, 'cn')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /session-report-ok/);
});
