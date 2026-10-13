import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_WATCH, todayStamp } from '../paths.js';
import { loadManyHistoricals } from '../historicals.js';
import { STAGE_LIST } from './cycle.js';
import { finiteNumber as num } from '../numbers.js';
import { loadUniverseSnapshots, summarizeUniverse } from './watch-universe-score.js';

const SCORE_JSON = '准确率.json';
const SCORE_MD = '准确率.md';
const BENCH = 'QQQ';
const USEFUL_ATR = 0.5;

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function pct(from, to) {
  if (!(from > 0) || to == null) return null;
  return round(((to / from) - 1) * 100, 2);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function etHour(date = new Date()) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  }).formatToParts(date).find((part) => part.type === 'hour')?.value;
  return Number(hour);
}

function sessionClosed(day, now = new Date()) {
  const today = todayStamp(now);
  if (!day) return false;
  if (day < today) return true;
  if (day > today) return false;
  return etHour(now) >= 16;
}

function nextBar(bars, callDate) {
  return (bars || []).find((bar) => bar.date > callDate) || null;
}

function mean(values) {
  const xs = values.map(num).filter((n) => n != null);
  if (!xs.length) return null;
  return round(xs.reduce((s, n) => s + n, 0) / xs.length, 2);
}

function wilsonInterval(hits, n, z = 1.96) {
  if (!n) return { low: null, high: null, level: 95 };
  const p = hits / n;
  const z2 = z ** 2;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    low: round(Math.max(0, center - margin) * 100, 1),
    high: round(Math.min(1, center + margin) * 100, 1),
    level: 95
  };
}

function median(values) {
  const xs = values.map(num).filter((n) => n != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, 2);
}

export function lookupStageRate(score, stage) {
  const book = score?.locked?.byStage;
  if (!book) return null;
  if (stage && book[stage]) return book[stage];
  return Object.values(book).find((row) => row.label === stage) || null;
}

export function formatWinRate(stats) {
  if (!stats?.n) return '命中率待结算';
  return `次日命中 ${stats.rate}%（${stats.hits}/${stats.n}）`;
}

function tallyByStage(picks) {
  const locked = picks.filter((row) => row.status === 'locked' && row.retPct != null);
  const out = {};
  for (const stage of STAGE_LIST) {
    out[stage.id] = {
      id: stage.id,
      label: stage.label,
      no: stage.no,
      tradeable: stage.tradeable,
      ...tally(locked.filter((row) => (row.stage || 'unknown') === stage.id))
    };
  }
  return out;
}

function tally(picks) {
  const locked = picks.filter((row) => row.status === 'locked' && row.retPct != null);
  const n = locked.length;
  const hits = locked.filter((row) => row.hit).length;
  const usefulKnown = locked.filter((row) => row.useful != null);
  const useful = usefulKnown.filter((row) => row.useful).length;
  const vsQqq = locked.filter((row) => row.vsQqq).length;
  const vsQqqN = locked.filter((row) => row.qqqRetPct != null).length;
  const directionalReturns = locked.map((row) => row.directionalRet);
  const directionalAlpha = locked.map((row) => row.directionalAlpha);
  const wins = directionalReturns.filter((value) => num(value) > 0);
  const losses = directionalReturns.filter((value) => num(value) < 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const alwaysUpHits = locked.filter((row) => row.retPct > 0).length;
  const alwaysDownHits = locked.filter((row) => row.retPct < 0).length;
  const alwaysUpRate = n ? round((alwaysUpHits / n) * 100, 1) : null;
  const alwaysDownRate = n ? round((alwaysDownHits / n) * 100, 1) : null;
  const randomRate = n ? round((alwaysUpHits + alwaysDownHits) / n * 50, 1) : null;
  const bestSimpleRate = n ? Math.max(alwaysUpRate, alwaysDownRate, randomRate) : null;
  const days = new Set(locked.map((row) => row.callDate).filter(Boolean)).size;
  return {
    n,
    days,
    hits,
    rate: n ? round((hits / n) * 100, 1) : null,
    confidence: wilsonInterval(hits, n),
    confidenceCaveat: '按独立样本近似；同日股票相关，区间可能偏窄',
    useful,
    usefulN: usefulKnown.length,
    usefulUnknown: n - usefulKnown.length,
    usefulRate: usefulKnown.length ? round((useful / usefulKnown.length) * 100, 1) : null,
    vsQqq,
    vsQqqRate: vsQqqN ? round((vsQqq / vsQqqN) * 100, 1) : null,
    avgRet: mean(locked.map((row) => row.retPct)),
    avgQqq: mean(locked.map((row) => row.qqqRetPct)),
    avgAlpha: mean(locked.filter((row) => row.alpha != null).map((row) => row.alpha)),
    avgDirectionalRet: mean(directionalReturns),
    medianDirectionalRet: median(directionalReturns),
    avgDirectionalAlpha: mean(directionalAlpha),
    avgWin,
    avgLoss,
    payoffRatio: avgWin != null && avgLoss != null && avgLoss !== 0
      ? round(avgWin / Math.abs(avgLoss), 2)
      : null,
    expectancy: mean(directionalReturns),
    baselines: {
      randomRate,
      alwaysUpRate,
      alwaysDownRate,
      bestSimpleRate,
      bestSimple: alwaysDownRate >= alwaysUpRate && alwaysDownRate >= 50
        ? '全部看跌'
        : alwaysUpRate >= 50
          ? '全部看涨'
          : '随机方向',
      edgePctPoints: n ? round((hits / n) * 100 - bestSimpleRate, 1) : null
    }
  };
}

function gradePick(row, to, qqqRetPct, { status, settleDate, toSource }) {
  const from = num(row.last);
  const retPct = pct(from, to);
  const atr = num(row.atr);
  const atrPct = num(row.atrPct) ?? (atr != null && from > 0 ? round((atr / from) * 100, 2) : null);
  const hit = retPct == null
    ? null
    : row.side === 'down'
      ? retPct < 0
      : retPct > 0;
  const useful = hit == null
    ? null
    : !(atrPct > 0)
      ? null
      : Boolean(hit) && Math.abs(retPct) >= atrPct * USEFUL_ATR;
  const alpha = retPct == null || qqqRetPct == null ? null : round(retPct - qqqRetPct, 2);
  const directionalRet = retPct == null ? null : round(row.side === 'down' ? -retPct : retPct, 2);
  const directionalAlpha = alpha == null ? null : round(row.side === 'down' ? -alpha : alpha, 2);
  const vsQqq = retPct == null || qqqRetPct == null
    ? null
    : row.side === 'down'
      ? retPct < qqqRetPct
      : retPct > qqqRetPct;
  return {
    callDate: row.callDate,
    version: row.version || 'v1-legacy',
    settleDate,
    symbol: row.symbol,
    side: row.side,
    stage: row.stage || null,
    stageLabel: row.stageLabel || null,
    score: row.score ?? null,
    from,
    to,
    toSource,
    retPct,
    atr,
    atrPct,
    qqqRetPct,
    alpha,
    directionalRet,
    directionalAlpha,
    hit,
    useful,
    vsQqq,
    status
  };
}

function flattenPicks(pack) {
  const callDate = pack.date;
  return [
    ...(pack.featured?.up || []).map((row) => ({ ...row, version: row.version || pack.strategy?.version, side: 'up', callDate })),
    ...(pack.featured?.down || []).map((row) => ({ ...row, version: row.version || pack.strategy?.version, side: 'down', callDate }))
  ].filter((row) => row.symbol && num(row.last) > 0);
}

async function listCallPacks() {
  let names = [];
  try {
    names = await readdir(OBSIDIAN_WATCH);
  } catch {
    return [];
  }
  const dates = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  const packs = [];
  for (const name of dates) {
    const pack = await readJson(join(OBSIDIAN_WATCH, 'snapshots', name)) || await readJson(join(OBSIDIAN_WATCH, name));
    if (pack?.featured && pack.date) packs.push(pack);
  }
  return packs;
}

async function settlePack(pack, hists, now = new Date()) {
  const qqqBars = hists[BENCH]?.ok ? hists[BENCH].bars : [];
  const qqqNext = nextBar(qqqBars, pack.date);
  // No matching signal-time benchmark quote in legacy files: do not manufacture alpha.
  const qqqFrom = num(pack.benchmarkSnapshot?.last);
  const picks = [];
  for (const row of flattenPicks(pack)) {
    const bars = hists[row.symbol]?.ok ? hists[row.symbol].bars : [];
    const nxt = nextBar(bars, pack.date);
    const to = nxt?.close > 0 ? nxt.close : null;
    const settleDate = nxt?.date || null;
    const locked = Boolean(settleDate && sessionClosed(settleDate, now) && to != null);
    const status = to == null ? 'pending' : (locked ? 'locked' : 'pending');
    const aligned = row.quoteAt && pack.benchmarkSnapshot?.quoteAt && Math.abs(row.quoteAt - pack.benchmarkSnapshot.quoteAt) <= 60000;
    const qqqRetPct = aligned && qqqNext?.close > 0 && qqqFrom > 0 && qqqNext.date === settleDate
      ? pct(qqqFrom, qqqNext.close)
      : null;
    picks.push(gradePick(row, to, qqqRetPct, { status, settleDate, toSource: to ? 'daily' : null }));
  }
  const locked = picks.every((row) => row.status === 'locked') && picks.length > 0;
  return {
    callDate: pack.date,
    settleDate: picks.find((row) => row.settleDate)?.settleDate || null,
    status: !picks.length ? 'empty' : (locked ? 'locked' : 'pending'),
    picks
  };
}

function renderScoreMarkdown(board) {
  const fmt = (side) => {
    const s = board.locked?.[side] || {};
    if (!s.n) return '还没有已结算样本。';
    return `${s.hits}/${s.n}（${s.rate}%）· 有意义 ${s.useful}/${s.usefulN}（${s.usefulRate}%）· 方向收益均值 ${s.avgDirectionalRet == null ? '—' : `${s.avgDirectionalRet >= 0 ? '+' : ''}${s.avgDirectionalRet}%`}`;
  };
  const stages = STAGE_LIST.map((stage) => {
    const s = board.locked?.byStage?.[stage.id] || {};
    const rate = s.n ? `${s.rate}%（${s.hits}/${s.n}）` : '待结算';
    const useful = s.n ? `${s.useful}/${s.n}` : '—';
    return `| ${stage.no || '—'} | ${stage.label} | ${rate} | ${useful} |`;
  }).join('\n');
  const recent = (board.recent || []).map((row) => (
    `| ${row.callDate} | ${row.settleDate || '—'} | ${row.side === 'down' ? '跌' : '涨'} | ${row.symbol} | ${row.stageLabel || '—'} | ${row.retPct == null ? '—' : `${row.retPct >= 0 ? '+' : ''}${row.retPct}%`} | ${row.status === 'pending' ? '待结算' : (row.hit ? '对' : '错')} | ${row.useful ? '是' : (row.hit ? '否' : '—')} |`
  )).join('\n');
  return `---
title: 每日观察准确率
type: watch-score
liveTrading: false
---

# 每日观察次日方向命中率

> 只记「最可能上涨 / 最可能下跌」。下一交易日收盘对比观察日现价。上涨候选收涨算对，下跌候选收跌算对，平盘不算对。有意义：方向对，且至少走出 0.5 ATR。相对 QQQ 只作对照，不计入主准确率。阶段胜率是同一批样本按 Cycle 阶段拆开。不进推荐 / 模拟 / 实际操作。

- 合计：${fmt('all')}
- 上涨候选：${fmt('up')}
- 下跌候选：${fmt('down')}
- 相对 QQQ：${board.locked?.all?.vsQqqRate == null ? '—' : `${board.locked.all.vsQqqRate}%`}
- 独立交易日：${board.locked?.all?.days || 0} 日
- 95% 置信区间：${board.locked?.all?.confidence?.low == null ? '—' : `${board.locked.all.confidence.low}% ~ ${board.locked.all.confidence.high}%`}
- 方向收益代理：${board.locked?.all?.avgDirectionalRet == null ? '—' : `${board.locked.all.avgDirectionalRet >= 0 ? '+' : ''}${board.locked.all.avgDirectionalRet}%`}（看跌已反向计分，未计成本）
- 命中 / 错误均值：${board.locked?.all?.avgWin == null ? '—' : `+${board.locked.all.avgWin}%`} / ${board.locked?.all?.avgLoss == null ? '—' : `${board.locked.all.avgLoss}%`} · 盈亏比 ${board.locked?.all?.payoffRatio ?? '—'}
- 最佳简单基线：${board.locked?.all?.baselines?.bestSimple || '—'} ${board.locked?.all?.baselines?.bestSimpleRate == null ? '—' : `${board.locked.all.baselines.bestSimpleRate}%`} · 策略超额 ${board.locked?.all?.baselines?.edgePctPoints == null ? '—' : `${board.locked.all.baselines.edgePctPoints >= 0 ? '+' : ''}${board.locked.all.baselines.edgePctPoints}pp`}

## 精选候选按形态统计

| # | 阶段 | 次日命中率 | 有意义 |
| --- | --- | ---: | ---: |
${stages}

## 全观察池形态统计（独立口径）

${board.universe?.rule || '尚未采集完整观察池。'}

- 首次完整采集：${board.universe?.firstDate || '未采集'}
- 旧档缺完整股票池：${board.universe?.uncollectedDates?.length || 0} 日，不回填、不混入精选候选样本。

| 形态 | 已结算 | 待结算 | 缺观察价等无效记录 | 次日上涨率 | 次日下跌率 | 平均涨跌 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.values(board.universe?.byStage || {}).map((row) => `| ${row.label} | ${row.n} | ${row.pending} | ${row.excluded} | ${row.upRate == null ? '—' : `${row.upRate}%`} | ${row.downRate == null ? '—' : `${row.downRate}%`} | ${row.avgRet == null ? '—' : `${row.avgRet}%`} |`).join('\n')}

| 观察日 | 结算日 | 方向 | 代码 | 阶段 | 次日 | 对错 | 有意义 |
| --- | --- | --- | --- | --- | ---: | --- | --- |
${recent || '| — |  |  |  |  |  | 还没有记录 |  |'}
`;
}

function summarize(days) {
  const picks = days.flatMap((day) => day.picks || []);
  const lockedPicks = picks.filter((row) => row.status === 'locked');
  const pending = picks.filter((row) => row.status === 'pending');
  const recent = [...picks].reverse().slice(0, 24);
  return {
    ok: true,
    schemaVersion: 4,
    liveTrading: false,
    type: 'watch-score',
    updatedAt: new Date().toISOString(),
    rule: `下一交易日收盘 vs 观察日现价。上涨候选收涨算对，下跌候选收跌算对。平盘不算对。有意义=方向对且至少 ${USEFUL_ATR} ATR。相对 QQQ 只对照。`,
    usefulAtr: USEFUL_ATR,
    bench: BENCH,
    locked: {
      all: tally(lockedPicks),
      up: tally(lockedPicks.filter((row) => row.side === 'up')),
      down: tally(lockedPicks.filter((row) => row.side === 'down')),
      byStage: tallyByStage(lockedPicks),
      byVersion: Object.fromEntries([...new Set(lockedPicks.map((p) => p.version))].map((version) => [version, { ...tally(lockedPicks.filter((p) => p.version === version)), byStage: tallyByStage(lockedPicks.filter((p) => p.version === version)) }]))
    },
    pending,
    recent,
    days
  };
}

export async function loadWatchScore() {
  return readJson(join(OBSIDIAN_WATCH, SCORE_JSON));
}

export async function updateWatchScore({ asOf } = {}) {
  const packs = (await listCallPacks()).filter((pack) => !asOf || pack.date <= asOf);
  const snapshots = (await loadUniverseSnapshots()).filter((pack) => !asOf || pack.date <= asOf);
  if (!packs.length && !snapshots.length) {
    const empty = summarize([]);
    empty.universe = summarizeUniverse([], {});
    empty.note = '还没有每日观察可结算。';
    return empty;
  }
  const symbols = [...new Set([
    ...packs.flatMap((pack) => flattenPicks(pack).map((row) => row.symbol)),
    ...snapshots.flatMap((pack) => pack.rows.map((row) => row.symbol)), BENCH
  ])];
  const hists = await loadManyHistoricals(symbols, { concurrency: 4 });
  const days = [];
  for (const pack of packs) {
    if (asOf && pack.date > asOf) continue;
    days.push(await settlePack(pack, hists));
  }
  const board = summarize(days);
  board.universe = summarizeUniverse(snapshots, hists, { legacyDates: packs.map((pack) => pack.date) });
  try {
    await mkdir(OBSIDIAN_WATCH, { recursive: true });
    await writeFile(join(OBSIDIAN_WATCH, SCORE_JSON), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    await writeFile(join(OBSIDIAN_WATCH, SCORE_MD), `${renderScoreMarkdown(board)}\n`, 'utf8');
  } catch {
    board.writeError = '准确率文件未能写入，页面仍可显示本次结算。';
  }
  return board;
}

export async function attachWatchScore(pack, { refresh = false } = {}) {
  if (!pack) return pack;
  let score = await loadWatchScore();
  const pending = score?.pending?.length || 0;
  const missing = !score?.ok;
  const outdated = score?.schemaVersion !== 4;
  if (refresh) {
    try {
      score = await updateWatchScore({ asOf: todayStamp() });
    } catch (error) {
      score = score || { ok: false, error: error.message };
      if (!score.error) score.error = error.message;
    }
  }
  pack.score = score || null;
  pack.scoreNeedsRefresh = Boolean(missing || pending || outdated);
  return pack;
}
