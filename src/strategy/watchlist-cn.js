import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chinaStamp, lastChinaSessionStamp, OBSIDIAN_WATCH, REPORTS_DIR } from '../paths.js';
import { fetchChinaQuotes, loadChinaWatchlists } from '../screener/cn-market-data.mjs';

const MAX = { featured: 3, surge: 4, drop: 4, turnover: 4, cheap: 4 };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function take(rows, n) {
  return rows.slice(0, n);
}

function yuan(n) {
  return n == null ? '—' : `¥${Number(n).toFixed(2)}`;
}

function signedPct(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
}

function card(meta, quote) {
  const last = num(quote?.price);
  const changePct = num(quote?.dailyChange);
  const turnover = num(quote?.turnover);
  const pe = num(quote?.pe);
  const pb = num(quote?.pb);
  return {
    symbol: meta.symbol,
    company: quote?.company || meta.company || meta.symbol,
    lists: meta.lists || [],
    priceDate: quote?.marketDate && Number.isFinite(new Date(quote.marketDate).getTime()) ? chinaStamp(new Date(quote.marketDate)) : null,
    quoteAt: quote?.marketDate || null,
    last,
    changePct,
    turnover,
    pe,
    pb,
    marketCap: num(quote?.marketCap),
    exchange: quote?.exchange?.label || null,
    note: last == null ? 'DATA UNAVAILABLE：无公开行情' : ''
  };
}

function thesis(row, side) {
  const bits = [row.company];
  bits.push(`当日 ${signedPct(row.changePct)}`);
  if (row.turnover != null) bits.push(`换手 ${row.turnover.toFixed(1)}%`);
  if (row.pe != null && row.pe > 0) bits.push(`PE ${row.pe.toFixed(1)}`);
  if (row.lists?.length) bits.push(row.lists.slice(0, 2).join(' / '));
  const tip = side === 'up'
    ? '当日相对 list 最强，不是目标价。'
    : side === 'down'
      ? '当日相对 list 最弱，不是做空指令。'
      : '低 PE 只说明估值位置，不是当日最强，也不抵消最弱名单。';
  return `${bits.join(' · ')}。${tip}`;
}

export function cnCheapCard(row) {
  return decorate(row, 'neutral', '低PE');
}

function decorate(row, side, label) {
  return {
    ...row,
    side,
    stageLabel: label,
    thesis: thesis(row, side)
  };
}

function pickFeatured(rows) {
  const priced = rows.filter((row) => row.last > 0 && row.changePct != null);
  const up = take(
    [...priced].filter((row) => row.changePct > 0).sort((a, b) => b.changePct - a.changePct || (b.turnover || 0) - (a.turnover || 0)),
    MAX.featured
  ).map((row) => decorate(row, 'up', '当日最强'));
  const upSet = new Set(up.map((row) => row.symbol));
  const down = take(
    [...priced].filter((row) => row.changePct < 0 && !upSet.has(row.symbol)).sort((a, b) => a.changePct - b.changePct || (b.turnover || 0) - (a.turnover || 0)),
    MAX.featured
  ).map((row) => decorate(row, 'down', '当日最弱'));
  return { up, down };
}

export function renderCnWatchMarkdown(pack) {
  const line = (row) => `| ${row.symbol} | ${row.company || ''} | ${row.last == null ? '—' : Number(row.last).toFixed(2)} | ${signedPct(row.changePct)} | ${row.turnover == null ? '—' : `${row.turnover.toFixed(1)}%`} | ${row.pe == null ? '—' : row.pe.toFixed(1)} | ${(row.lists || []).join(' / ') || '—'} |`;
  const sec = (title, rows, empty) => `### ${title}

| 代码 | 名称 | 现价 | 当日 | 换手 | PE | 来源 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${(rows || []).map(line).join('\n') || `| — |  |  |  |  |  | ${empty} |`}
`;
  return `---
title: A股每日观察
date: ${pack.date}
type: daily-watchlist-cn
liveTrading: false
---

# ${pack.date} A股每日观察

> 只扫 A 股 list 的公开行情。不是美股 Cycle，不是目标价，不是下单。不进推荐 / 模拟 / 实际操作。

扫描 ${pack.scanned} 只 · 来源 ${(pack.lists || []).map((row) => row.title).join('、') || 'A股 List'}。

## 今日偏多

${(pack.featured?.up || []).map((row) => `#### ${row.symbol} ${row.company}

- ${row.thesis}
`).join('\n') || '今日 list 里没有收涨的名字。'}

## 今日偏空

${(pack.featured?.down || []).map((row) => `#### ${row.symbol} ${row.company}

- ${row.thesis}
`).join('\n') || '今日 list 里没有收跌的名字。'}

${sec('大涨', pack.boards?.surge, '没有涨幅较大的名字')}

${sec('大跌', pack.boards?.drop, '没有跌幅较大的名字')}

${sec('高换手', pack.boards?.turnover, '没有明显放量换手')}

${sec('低 PE', pack.boards?.cheap, '没有低 PE 的名字')}
`;
}

export async function buildCnWatchlist({ date } = {}) {
  const day = date || lastChinaSessionStamp();
  const lists = await loadChinaWatchlists();
  const bySymbol = {};
  for (const list of lists) {
    for (const stock of list.stocks || []) {
      const symbol = String(stock.symbol || '');
      if (!/^\d{6}$/.test(symbol)) continue;
      if (!bySymbol[symbol]) bySymbol[symbol] = { symbol, company: stock.company, lists: [] };
      bySymbol[symbol].lists.push(list.title);
    }
  }
  const metas = Object.values(bySymbol);
  const quotes = metas.length ? await fetchChinaQuotes(metas) : new Map();
  const rows = metas.map((meta) => card(meta, quotes.get(meta.symbol)));
  const featured = pickFeatured(rows);
  const priced = rows.filter((row) => row.last > 0 && row.changePct != null);
  return {
    ok: true,
    liveTrading: false,
    type: 'daily-watchlist-cn',
    market: 'cn',
    currency: 'CNY',
    date: day,
    generatedAt: new Date().toISOString(),
    scanned: metas.length,
    lists: lists.map((list) => ({ id: list.id, title: list.title, total: list.total })),
    listError: lists.length ? null : 'A股 List 缺失',
    counts: {
      up: featured.up.length,
      down: featured.down.length,
      surge: priced.filter((row) => row.changePct >= 3).length,
      drop: priced.filter((row) => row.changePct <= -3).length
    },
    featured,
    boards: {
      surge: take([...priced].filter((row) => row.changePct >= 3).sort((a, b) => b.changePct - a.changePct), MAX.surge)
        .map((row) => decorate(row, 'up', '大涨')),
      drop: take([...priced].filter((row) => row.changePct <= -3).sort((a, b) => a.changePct - b.changePct), MAX.drop)
        .map((row) => decorate(row, 'down', '大跌')),
      turnover: take([...priced].filter((row) => row.turnover >= 3).sort((a, b) => b.turnover - a.turnover), MAX.turnover)
        .map((row) => decorate(row, row.changePct >= 0 ? 'up' : 'down', '高换手')),
      cheap: take([...priced].filter((row) => row.pe > 0 && row.pe <= 20).sort((a, b) => a.pe - b.pe), MAX.cheap)
        .map((row) => cnCheapCard(row))
    },
    note: 'A股足迹：当日涨跌与换手。不套用美股 Cycle / 价位图。不是下单。'
  };
}

export async function writeCnWatchlist(pack) {
  await mkdir(OBSIDIAN_WATCH, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
  const stem = `${pack.date}-cn`;
  await writeFile(join(OBSIDIAN_WATCH, `${stem}.json`), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  await writeFile(join(OBSIDIAN_WATCH, `${stem}.md`), `${renderCnWatchMarkdown(pack)}\n`, 'utf8');
  await writeFile(join(REPORTS_DIR, `${stem}.json`), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  await writeFile(join(REPORTS_DIR, `${stem}.md`), `${renderCnWatchMarkdown(pack)}\n`, 'utf8');
  return { dir: OBSIDIAN_WATCH, date: pack.date, file: stem };
}

async function latestCnJson() {
  const dirs = [OBSIDIAN_WATCH, REPORTS_DIR];
  for (const dir of dirs) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const dates = names
      .filter((name) => /^\d{4}-\d{2}-\d{2}-cn\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort()
      .reverse();
    for (const day of dates) {
      const pack = await readJson(join(dir, `${day}-cn.json`));
      if (pack) return { day, pack };
    }
  }
  return null;
}

export async function loadCnWatchlist(date, { auto = true } = {}) {
  const calendar = date || chinaStamp();
  const day = date || lastChinaSessionStamp();
  const exact = (await readJson(join(OBSIDIAN_WATCH, `${day}-cn.json`)))
    || (await readJson(join(REPORTS_DIR, `${day}-cn.json`)));
  if (exact) return exact;
  if (date) return null;
  if (auto) {
    try {
      const built = await buildAndWriteCnWatchlist({ date: day });
      built.autoBuilt = true;
      built.requestedDate = calendar;
      return built;
    } catch (error) {
      const latest = await latestCnJson();
      if (!latest?.pack) return { ok: false, empty: true, market: 'cn', error: error.message, note: `A股观察扫描失败：${error.message}` };
      return {
        ...latest.pack,
        ok: latest.pack.ok !== false,
        stale: true,
        requestedDate: calendar,
        note: `自动扫描 ${day} 失败：${error.message}。先显示 ${latest.pack.date || latest.day}。`
      };
    }
  }
  const latest = await latestCnJson();
  if (!latest?.pack) return { ok: false, empty: true, market: 'cn', note: '还没有 A 股每日观察。' };
  return { ...latest.pack, stale: true, requestedDate: calendar };
}

export async function buildAndWriteCnWatchlist({ date } = {}) {
  const pack = await buildCnWatchlist({ date });
  if (pack.listError || !pack.scanned) throw new Error(pack.listError || '没有可扫描的 A 股清单，未覆盖已有观察板');
  await writeCnWatchlist(pack);
  return pack;
}
