import { finiteNumber } from '../numbers.js';
import { nextSessionDate } from './time.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_OPTIONS, todayStamp } from '../paths.js';
import { loadManyHistoricals } from '../historicals.js';

const SCORE_JSON = '准确率.json';
const SCORE_MD = '准确率.md';
const USEFUL_FLOOR = 0.5;

function num(value) {
  const n = finiteNumber(value);
  return Number.isFinite(n) ? n : null;
}

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

export function nextBar(bars, callDate) {
  return (bars || []).find((bar) => bar.date === nextSessionDate(callDate)) || null;
}

function mean(values) {
  const xs = values.map(num).filter((n) => n != null);
  if (!xs.length) return null;
  return round(xs.reduce((s, n) => s + n, 0) / xs.length, 2);
}

function expectedPct(row) {
  const raw = num(row.expectedMovePct);
  if (raw == null) return null;
  return raw <= 1 ? round(raw * 100, 2) : round(raw, 2);
}

function usefulNeed(row) {
  const exp = expectedPct(row);
  if (exp == null) return USEFUL_FLOOR;
  return Math.max(USEFUL_FLOOR, round(exp * 0.4, 2));
}

function bucketOf(row, pack) {
  if ((pack.buys || []).some((item) => item.symbol === row.symbol)) return 'buy';
  if (row.tempting || (pack.tempting || []).some((item) => item.symbol === row.symbol)) return 'tempting';
  return 'scan';
}

function sideOf(row) {
  if (row.direction === 'up' || row.lean === '看涨') return 'up';
  if (row.direction === 'down' || row.lean === '看跌') return 'down';
  return null;
}

function flattenPicks(pack) {
  const callDate = pack.date;
  const seen = new Set();
  return (pack.ideas || []).map((row) => {
    const side = sideOf(row);
    const last = num(row.last);
    if (!row.symbol || !side || !(last > 0)) return null;
    const key = `${row.symbol}:${side}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      symbol: row.symbol,
      side,
      last,
      callDate,
      bucket: bucketOf(row, pack),
      action: row.action || null,
      lean: row.lean || (side === 'up' ? '看涨' : '看跌'),
      cov: num(row.cov),
      expectedMovePct: expectedPct(row),
      usefulNeed: usefulNeed(row),
      strategyId: pack.strategy?.id || row.strategyId || 'cov'
    };
  }).filter(Boolean);
}

function tally(picks) {
  const locked = picks.filter((row) => row.status === 'locked' && row.retPct != null);
  const n = locked.length;
  const hits = locked.filter((row) => row.hit).length;
  const useful = locked.filter((row) => row.useful).length;
  return {
    n,
    hits,
    rate: n ? round((hits / n) * 100, 1) : null,
    useful,
    usefulRate: n ? round((useful / n) * 100, 1) : null,
    avgRet: mean(locked.map((row) => row.retPct))
  };
}

function gradePick(row, to, { status, settleDate }) {
  const from = num(row.last);
  const retPct = pct(from, to);
  const hit = retPct == null ? null : (row.side === 'down' ? retPct < 0 : retPct > 0);
  const need = num(row.usefulNeed) ?? USEFUL_FLOOR;
  const useful = hit == null ? null : Boolean(hit) && Math.abs(retPct) >= need;
  return {
    callDate: row.callDate,
    settleDate,
    symbol: row.symbol,
    side: row.side,
    lean: row.lean,
    bucket: row.bucket,
    action: row.action,
    cov: row.cov,
    from,
    to,
    retPct,
    expectedMovePct: row.expectedMovePct,
    usefulNeed: need,
    hit,
    useful,
    status,
    strategyId: row.strategyId
  };
}

async function listCallPacks() {
  let names = [];
  try {
    names = await readdir(OBSIDIAN_OPTIONS);
  } catch {
    return [];
  }
  const files = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?\.json$/.test(name) && name !== SCORE_JSON)
    .sort();
  const packs = [];
  for (const name of files) {
    const pack = await readJson(join(OBSIDIAN_OPTIONS, name));
    if (pack?.date && (pack.ideas || []).length) packs.push(pack);
  }
  return packs;
}

async function settlePack(pack, hists, now = new Date()) {
  const picks = [];
  for (const row of flattenPicks(pack)) {
    const bars = hists[row.symbol]?.ok ? hists[row.symbol].bars : [];
    const nxt = nextBar(bars, pack.date);
    const to = nxt?.close > 0 ? nxt.close : null;
    const settleDate = nxt?.date || null;
    const locked = Boolean(settleDate && sessionClosed(settleDate, now) && to != null);
    const status = to == null ? 'pending' : (locked ? 'locked' : 'pending');
    picks.push(gradePick(row, to, { status, settleDate }));
  }
  const locked = picks.length > 0 && picks.every((row) => row.status === 'locked');
  return {
    callDate: pack.date,
    settleDate: picks.find((row) => row.settleDate)?.settleDate || null,
    strategyId: pack.strategy?.id || 'cov',
    status: !picks.length ? 'empty' : (locked ? 'locked' : 'pending'),
    picks
  };
}

function renderScoreMarkdown(board) {
  const fmt = (side) => {
    const s = board.locked?.[side] || {};
    if (!s.n) return '还没有已结算样本。';
    return `${s.hits}/${s.n}（${s.rate}%）· 有意义 ${s.useful}/${s.n}（${s.usefulRate}%）· 次日均 ${s.avgRet == null ? '—' : `${s.avgRet >= 0 ? '+' : ''}${s.avgRet}%`}`;
  };
  const recent = (board.recent || []).map((row) => (
    `| ${row.callDate} | ${row.settleDate || '—'} | ${row.symbol} | ${row.side === 'down' ? '跌' : '涨'} | ${row.bucket === 'buy' ? '买入' : (row.bucket === 'tempting' ? '诱人不买' : '扫描')} | ${row.retPct == null ? '—' : `${row.retPct >= 0 ? '+' : ''}${row.retPct}%`} | ${row.status === 'pending' ? '待结算' : (row.hit ? '对' : '错')} | ${row.useful ? '是' : (row.hit ? '否' : '—')} |`
  )).join('\n');
  return `---
title: 期权判断准确率
type: option-score
liveTrading: false
---

# 期权判断准确率

> 只记有看涨 / 看跌的扫描行。下一交易日收盘对比扫描日现价。看涨收涨算对，看跌收跌算对，平盘不算对。有意义：方向对，且至少走出预期波动的 40%（没有预期波动则 0.5%）。方向对不等于期权赚钱。不进推荐 / 模拟 / 实际操作。

- 合计：${fmt('all')}
- 看涨：${fmt('up')}
- 看跌：${fmt('down')}
- 买入候选：${fmt('buy')}
- 诱人不买：${fmt('tempting')}

| 观察日 | 结算日 | 代码 | 方向 | 桶 | 次日 | 对错 | 有意义 |
| --- | --- | --- | --- | --- | ---: | --- | --- |
${recent || '| — |  |  |  |  |  | 还没有记录 |  |'}
`;
}

function summarize(days) {
  const picks = days.flatMap((day) => day.picks || []);
  const lockedPicks = picks.filter((row) => row.status === 'locked');
  const pending = picks.filter((row) => row.status === 'pending');
  const recent = [...picks].reverse().slice(0, 36);
  return {
    ok: true,
    liveTrading: false,
    type: 'option-score',
    updatedAt: new Date().toISOString(),
    rule: '下一交易日收盘 vs 扫描日现价。看涨收涨算对，看跌收跌算对。平盘不算对。有意义=方向对且至少走出预期波动的 40%。方向对不等于期权赚钱。',
    usefulFloor: USEFUL_FLOOR,
    locked: {
      all: tally(lockedPicks),
      up: tally(lockedPicks.filter((row) => row.side === 'up')),
      down: tally(lockedPicks.filter((row) => row.side === 'down')),
      buy: tally(lockedPicks.filter((row) => row.bucket === 'buy')),
      tempting: tally(lockedPicks.filter((row) => row.bucket === 'tempting')),
      scan: tally(lockedPicks.filter((row) => row.bucket === 'scan'))
    },
    pending,
    recent,
    days
  };
}

export async function loadOptionScore() {
  return readJson(join(OBSIDIAN_OPTIONS, SCORE_JSON));
}

export async function updateOptionScore({ asOf } = {}) {
  const packs = await listCallPacks();
  if (!packs.length) {
    const empty = summarize([]);
    empty.note = '还没有期权扫描可结算。';
    return empty;
  }
  const symbols = [...new Set(packs.flatMap((pack) => flattenPicks(pack).map((row) => row.symbol)))];
  const hists = await loadManyHistoricals(symbols, { concurrency: 4 });
  const days = [];
  for (const pack of packs) {
    if (asOf && pack.date > asOf) continue;
    days.push(await settlePack(pack, hists));
  }
  const board = summarize(days);
  try {
    await mkdir(OBSIDIAN_OPTIONS, { recursive: true });
    await writeFile(join(OBSIDIAN_OPTIONS, SCORE_JSON), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    await writeFile(join(OBSIDIAN_OPTIONS, SCORE_MD), `${renderScoreMarkdown(board)}\n`, 'utf8');
  } catch {
    board.writeError = '准确率文件未能写入，页面仍可显示本次结算。';
  }
  return board;
}

export async function attachOptionScore(pack, { refresh = false } = {}) {
  if (!pack) return pack;
  let score = await loadOptionScore();
  const pending = score?.pending?.length || 0;
  const missing = !score?.ok;
  if (refresh) {
    try {
      score = await updateOptionScore({ asOf: todayStamp() });
    } catch (error) {
      score = score || { ok: false, error: error.message };
      if (!score.error) score.error = error.message;
    }
  }
  pack.score = score || null;
  return pack;
}
