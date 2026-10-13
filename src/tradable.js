import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_TRADES, recsDir, todayStamp } from './paths.js';
import { loadAccounts, loadHoldings } from './holdings.js';
import { loadQuotes } from './quotes.js';
import { loadManyHistoricals } from './historicals.js';
import { addQty, buildPosterModel, computeLevels, trimQty } from './levels.js';
import { renderPosterHtml } from './posters.js';
import { closedBars } from './market-time.js';

const ACCOUNT_CAP = { main: 3, tactical: 3, agentic: 2 };
const SIDE_RANK = { SELL: 0, TRIM: 1, BUY: 2, ADD: 2 };
const NEAR = 0.02;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function isEquitySymbol(symbol) {
  return /^[A-Z][A-Z.]{0,5}$/.test(String(symbol || '').toUpperCase());
}

async function loadTodayRecs(date) {
  return (await readJson(join(recsDir('grok'), `${date}.json`))) || { accounts: [] };
}

function recFor(recs, accountId, symbol) {
  const book = (recs.accounts || []).find((row) => row.id === accountId);
  return (book?.recommendations || []).find((row) => String(row.symbol || '').toUpperCase() === symbol) || null;
}

function avgCostOf(pos) {
  if (pos.avgCost != null && Number.isFinite(Number(pos.avgCost))) return Number(pos.avgCost);
  const qty = Number(pos.qty);
  if (pos.cost != null && qty > 0) return Number(pos.cost) / qty;
  return null;
}

function spendable(holdings) {
  const cash = Number(holdings?.cash);
  const bp = Number(holdings?.buyingPower);
  if (Number.isFinite(cash) && cash > 0) return cash;
  if (Number.isFinite(bp) && bp > 0) return bp;
  return 0;
}

function cashLeft(cash, ideas, accountId) {
  let left = Number(cash) || 0;
  for (const row of ideas) {
    if (row.accountId !== accountId) continue;
    if (row.side === 'BUY' || row.side === 'ADD') left -= row.price * row.qty;
  }
  return left;
}

function openSide(holdings, symbol, side) {
  const want = side === 'BUY' || side === 'ADD' ? 'BUY' : 'SELL';
  return (holdings.openOrders || []).some((row) => {
    const sym = String(row.symbol || '').toUpperCase();
    const raw = String(row.side || row.type || '').toUpperCase();
    return sym === symbol && raw.includes(want);
  });
}

function idea({ accountId, accountLabel, pos, side, price, qty, reason, last, failPrice, urgency }) {
  return {
    accountId,
    accountLabel,
    symbol: pos.symbol,
    name: pos.name || pos.symbol,
    role: pos.role || '',
    side,
    price: Number(Number(price).toFixed(2)),
    qty: Number(qty),
    last,
    failPrice: failPrice != null ? Number(Number(failPrice).toFixed(2)) : null,
    reason,
    urgency,
    draft: true,
    liveTrading: false
  };
}

function buyQty(accountId, want, price, cash) {
  if (!(price > 0) || !(cash > 0) || want <= 0) return 0;
  if (accountId === 'main') {
    return Math.min(want, Math.floor(cash / price));
  }
  const affordable = Math.floor((cash / price) * 10000) / 10000;
  return Math.min(want, affordable);
}

function pickForPosition({ account, pos, quote, levels, rec, holdings, existing }) {
  const qty = Number(pos.qty) || 0;
  if (qty <= 0) return null;
  const last = quote?.ok && quote.last != null ? quote.last : (levels?.last ?? pos.last);
  if (last == null) return null;
  const recAction = String(rec?.action || '').toUpperCase();
  const tiny = qty <= 10 || (pos.cost != null && Number(pos.cost) < 3000);
  const reviewName = /待核|观察|碎片/.test(pos.role || '');
  const cost = avgCostOf(pos);
  const recStop = Number(rec?.failPrice);
  const sl = recStop > 0 ? recStop : (levels?.ok ? levels.sl : null);
  const r1 = levels?.ok ? levels.r1 : null;
  const s2 = levels?.ok ? levels.s2 : null;
  const nearR1 = r1 != null && last >= r1 * (1 - NEAR);
  const nearS2 = s2 != null && sl != null && last <= s2 * (1 + NEAR) && last > sl;
  const cash = cashLeft(spendable(holdings), existing, account.id);

  if (account.id !== 'main' && sl != null && last <= sl) {
    if (openSide(holdings, pos.symbol, 'SELL')) return null;
    return [idea({
      accountId: account.id,
      accountLabel: account.label,
      pos,
      side: 'SELL',
      price: last,
      qty,
      last,
      failPrice: sl,
      urgency: 'stop',
      reason: `现价已到/跌破失效 ${sl}。止损必须及时。`
    })];
  }

  if (account.id === 'main' && (tiny || reviewName || recAction === 'SELL' || recAction === 'TRIM')) {
    if (tiny || recAction === 'SELL') {
      if (openSide(holdings, pos.symbol, 'SELL')) return null;
      return [idea({
        accountId: account.id,
        accountLabel: account.label,
        pos,
        side: 'SELL',
        price: last,
        qty,
        last,
        failPrice: sl,
        urgency: 'clean',
        reason: tiny || reviewName
          ? '主账户碎片/待核验，优先清掉，不为每天有动作而留着。'
          : (rec?.detail || rec?.title || '推荐操作为 SELL')
      })];
    }
    if (recAction === 'TRIM') {
      const q = trimQty(qty);
      if (q > 0 && !openSide(holdings, pos.symbol, 'SELL')) {
        return [idea({
          accountId: account.id,
          accountLabel: account.label,
          pos,
          side: 'TRIM',
          price: r1 && last < r1 ? r1 : last,
          qty: q,
          last,
          failPrice: sl,
          urgency: 'take',
          reason: rec?.detail || rec?.title || '推荐操作为 TRIM'
        })];
      }
    }
  }

  if (account.id !== 'main' && (tiny || recAction === 'SELL') && qty <= 1) {
    if (openSide(holdings, pos.symbol, 'SELL')) return null;
    return [idea({
      accountId: account.id,
      accountLabel: account.label,
      pos,
      side: 'SELL',
      price: last,
      qty,
      last,
      failPrice: sl,
      urgency: 'clean',
      reason: recAction === 'SELL'
        ? (rec?.detail || rec?.title || '推荐操作为 SELL')
        : '1 股占位，清掉。'
    })];
  }

  if ((nearR1 || recAction === 'TRIM') && recAction !== 'ADD' && recAction !== 'BUY') {
    const q = trimQty(qty);
    if (q > 0 && !openSide(holdings, pos.symbol, 'SELL')) {
      return [idea({
        accountId: account.id,
        accountLabel: account.label,
        pos,
        side: 'TRIM',
        price: r1 && last < r1 ? r1 : last,
        qty: q,
        last,
        failPrice: sl,
        urgency: 'take',
        reason: r1
          ? `到/靠近 R1 ${r1}。限价卖出，止盈可以慢但到阻力可以减。成本 ${cost ?? '—'}。`
          : (rec?.detail || rec?.title || '推荐 TRIM')
      })];
    }
  }

  if (nearS2 && (recAction === 'ADD' || recAction === 'BUY')) {
    if (account.id === 'main' && (tiny || reviewName)) return null;
    if (openSide(holdings, pos.symbol, 'BUY')) return null;
    const q = buyQty(account.id, addQty(qty), s2, cash);
    if (q > 0) {
      return [idea({
        accountId: account.id,
        accountLabel: account.label,
        pos,
        side: 'BUY',
        price: s2,
        qty: q,
        last,
        failPrice: sl,
        urgency: 'add',
        reason: `推荐 ${recAction}，到/靠近 S2 ${s2}，仍高于失效 ${sl}。限价买入，按现仓和现金算数量。`
      })];
    }
  }

  return null;
}

function rank(row) {
  const side = SIDE_RANK[row.side] ?? 9;
  const urg = row.urgency === 'stop' ? 0 : row.urgency === 'clean' ? 1 : row.urgency === 'take' ? 2 : 3;
  return side * 10 + urg;
}

export async function buildTradableDesk({ date, deskId = 'grok' } = {}) {
  const day = date || todayStamp();
  const config = await loadAccounts(deskId);
  const recs = await loadTodayRecs(day);
  const books = [];
  for (const account of config.accounts) {
    books.push({ account, holdings: await loadHoldings(account) });
  }
  const symbols = [...new Set(books.flatMap(({ holdings }) => (holdings.positions || [])
    .map((row) => row.symbol)
    .filter(isEquitySymbol)))];
  const [quotes, hists] = await Promise.all([
    loadQuotes(symbols),
    loadManyHistoricals(symbols)
  ]);

  const ideas = [];
  for (const { account, holdings } of books) {
    const cap = ACCOUNT_CAP[account.id] ?? 2;
    const picked = [];
    const positions = (holdings.positions || []).filter((row) => isEquitySymbol(row.symbol) && Number(row.qty) > 0);
    const scored = [];
    for (const pos of positions) {
      const hist = hists[pos.symbol];
      const bars = closedBars(hist?.bars);
      const last = quotes[pos.symbol]?.ok ? quotes[pos.symbol].last : bars.at(-1)?.close;
      const levels = hist?.ok && bars.length ? computeLevels(bars, { lastOverride: last }) : { ok: false };
      const rec = recFor(recs, account.id, pos.symbol);
      const rows = pickForPosition({
        account,
        pos,
        quote: quotes[pos.symbol],
        levels,
        rec,
        holdings,
        existing: [...ideas, ...picked]
      });
      if (rows) scored.push(...rows);
    }
    scored.sort((a, b) => rank(a) - rank(b) || String(a.symbol).localeCompare(b.symbol));
    for (const row of scored) {
      if (picked.length >= cap) break;
      if (picked.some((x) => x.symbol === row.symbol && x.side === row.side)) continue;
      picked.push(row);
    }
    ideas.push(...picked);
  }

  ideas.sort((a, b) => rank(a) - rank(b) || String(a.accountId).localeCompare(b.accountId));

  const posIndex = new Map();
  for (const { account, holdings } of books) {
    for (const pos of holdings.positions || []) {
      if (pos.symbol) posIndex.set(`${account.id}:${pos.symbol}`, { account, pos });
    }
  }
  for (const row of ideas) {
    const hit = posIndex.get(`${row.accountId}:${row.symbol}`);
    const hist = hists[row.symbol];
    if (!hit || !hist?.ok) {
      row.analysisError = hist?.error || '无日线';
      continue;
    }
    const model = buildPosterModel({
      account: hit.account,
      position: hit.pos,
      bars: closedBars(hist.bars),
      quote: quotes[row.symbol],
      idea: { side: row.side, qty: row.qty, price: row.price, reason: row.reason }
    });
    if (!model.ok) {
      row.analysisError = model.error;
      continue;
    }
    row.brief = model.brief;
    row.analysisHtml = renderPosterHtml(model);
    row.levels = {
      r2: model.levels.r2,
      r1: model.levels.r1,
      s1: model.levels.s1,
      s2: model.levels.s2,
      sl: model.levels.sl,
      stop: row.failPrice,
      last: model.levels.last
    };
    if (row.failPrice != null && model.levels.sl != null && Math.abs(row.failPrice - model.levels.sl) > 0.005) {
      row.stopNote = `失效价按推荐止损 ${row.failPrice}；价位图技术 SL ${model.levels.sl} 仅作参考`;
    }
  }

  return {
    ok: true,
    liveTrading: false,
    draft: true,
    date: day,
    generatedAt: new Date().toISOString(),
    note: '草稿，不是下单指令。止损优先，止盈可以慢。主账户不为每天有动作而交易。只看已持仓，不编造新票。不进模拟引擎。',
    ideas,
    counts: {
      sell: ideas.filter((row) => row.side === 'SELL').length,
      trim: ideas.filter((row) => row.side === 'TRIM').length,
      buy: ideas.filter((row) => row.side === 'BUY' || row.side === 'ADD').length
    }
  };
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderTradableMarkdown(pack) {
  const rows = (pack.ideas || []).map((row) => (
    `| ${row.accountLabel} | ${row.symbol} | ${row.side} | ${row.qty} | ${money(row.price)} | ${money(row.last)} | ${money(row.failPrice)} | ${row.reason} |`
  )).join('\n');
  const analyses = (pack.ideas || []).map((row) => {
    const table = (row.brief?.table || []).map((item) => (
      `| ${item.label} | ${money(item.price)} | ${item.meaning} | ${item.action} |`
    )).join('\n');
    const size = (row.brief?.sizing?.lines || []).map((line) => `- ${line}`).join('\n');
    return `
## ${row.symbol} · ${row.accountLabel}

${row.side} ${row.qty} @ ${money(row.price)}。${row.reason || ''}

${row.brief?.resistance?.lead || ''}
${row.brief?.support?.lead || ''}

${size}

| 类型 | 价格 | 含义 | 操作参考 |
| --- | ---: | --- | --- |
${table || '| — |  |  | 无日线 |'}
`;
  }).join('\n');
  return `---
title: 今日买卖
date: ${pack.date}
type: daily-tradable
liveTrading: false
draft: true
---

# ${pack.date} 今日买卖（草稿）

> ${pack.note}
> 卖出价/买入价是限价或现价参考，不是已经挂上的单。点网页一行可看日线详细分析。

| 账户 | 代码 | 方向 | 数量 | 价格 | 现价 | 失效 | 理由 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
${rows || '| — |  |  |  |  |  |  | 今日没有必须执行的买卖 |'}

${analyses}
`;
}

function slimIdea(row) {
  const { analysisHtml, ...rest } = row;
  return rest;
}

export async function writeTradable(pack) {
  await mkdir(OBSIDIAN_TRADES, { recursive: true });
  const slim = { ...pack, ideas: (pack.ideas || []).map(slimIdea) };
  await writeFile(join(OBSIDIAN_TRADES, `${pack.date}.json`), `${JSON.stringify(slim, null, 2)}\n`, 'utf8');
  await writeFile(join(OBSIDIAN_TRADES, `${pack.date}.md`), `${renderTradableMarkdown(pack)}\n`, 'utf8');
  return { dir: OBSIDIAN_TRADES, date: pack.date, count: pack.ideas.length };
}

export async function loadTradableFile(date) {
  const day = date || todayStamp();
  return readJson(join(OBSIDIAN_TRADES, `${day}.json`));
}
