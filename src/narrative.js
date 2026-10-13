import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asOfStamp, OBSIDIAN_DAILY, REPORTS_DIR, todayStamp } from './paths.js';
import { accountById, holdingsFreshness, loadAccounts, loadHoldings, stockMarketValue } from './holdings.js';
import { parseFrontmatter } from './markdown.js';
import { loadCycleBook } from './strategy/cycle.js';

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '未接入';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function stanceOf(book) {
  const n = (book.positions || []).filter((row) => Number(row.qty) > 0).length;
  if (!n) return 'WAIT';
  if ((book.openOrders || []).length) return 'HOLD';
  return 'HOLD';
}

function headlineOf(book, stale, date) {
  if (stale) return `持仓档案不是今日实时。上次可靠扫描 ${book.asOf || '未知'}。`;
  if (book.pricesOk && asOfStamp(book.asOf) && asOfStamp(book.asOf) !== date) {
    return `价格已按公开行情刷新。股数仍是 ${book.asOf} 的券商扫描，本机不连 Robinhood。`;
  }
  const names = (book.positions || []).map((row) => row.symbol).filter(Boolean).join(' / ') || '空仓';
  const orders = book.openOrders || [];
  if (orders.length) return `净值 ${money(book.totalValue ?? book.equity)}。未完成订单 ${orders.map((row) => row.symbol).join(', ')}。`;
  return `净值 ${money(book.totalValue ?? book.equity)}。现仓 ${names}。`;
}

function positionRows(book, cycles = {}) {
  return (book.positions || []).map((row) => {
    const qty = Number(row.qty) || 0;
    const last = row.last != null ? Number(row.last) : null;
    const avg = row.avgCost != null ? Number(row.avgCost) : null;
    const mv = row.marketValue != null ? Number(row.marketValue) : (last != null ? qty * last : null);
    const pnl = row.unrealizedPnl != null
      ? Number(row.unrealizedPnl)
      : (mv != null && avg != null ? mv - qty * avg : null);
    const cycle = cycles[String(row.symbol || '').toUpperCase()];
    const strat = cycle?.ok ? `${cycle.stageLabel} · ${cycle.score}` : (cycle?.note || '—');
    return `| ${row.symbol} | ${qty} | ${avg == null ? '—' : money(avg)} | ${last == null ? '—' : money(last)} | ${mv == null ? '—' : money(mv)} | ${pnl == null ? '—' : money(pnl)} | ${strat} |`;
  }).join('\n');
}

function orderRows(book) {
  return (book.openOrders || []).map((row) => (
    `| ${row.symbol || ''} | ${row.side || row.type || ''} | ${row.qty ?? ''} | ${row.price ?? row.stopPrice ?? ''} | ${row.status || 'open'} | ${row.orderId || ''} |`
  )).join('\n');
}

export function renderAgenticNarrative({ date, book, stale = false, fills = [], cycles = {} }) {
  const nav = book.totalValue ?? book.equity;
  const stocks = stockMarketValue(book);
  const cash = book.cash;
  const bp = book.buyingPower;
  const stance = stale ? 'WAIT' : stanceOf(book);
  const headline = headlineOf(book, stale, date);
  const fillRows = (fills || []).map((row) => (
    `| ${row.symbol} | ${row.side} | ${row.qty ?? ''} | ${row.price ?? ''} | ${row.orderId || ''} | ${row.note || ''} |`
  )).join('\n');
  const md = `---
title: Agentic 小账户日报
date: ${date}
account: agentic-small
stance: ${stance}
live_trading: false
nav: ${nav ?? ''}
cash: ${cash ?? ''}
buyingPower: ${bp ?? ''}
positions: ${(book.positions || []).length}
headline: ${headline}
source: engine-snapshot
---

# ${date} Agentic 小账户日报

> 这是实盘 Agentic（••••${book.accountLast4 || '7983'}）的账户快照，**不是**纸上 0C。Council 长叙事仍可由扫描 Agent 补写；数字由引擎落盘，避免本页停在旧日期。
${stale ? `\n> **缺数据：下面不是今日实时持仓。** 上次可靠扫描 ${book.asOf || '无'}。禁止把昨日档案当成今日实时。\n` : ''}

## 账户摘要

| 项目 | 数值 |
| --- | ---: |
| 账户 | Robinhood Agentic 小账户 ••••${book.accountLast4 || '7983'} |
| 净值 | ${money(nav)} |
| 股票 | ${money(stocks)} |
| 现金 | ${money(cash)} |
| 购买力 | ${money(bp)} |
| 持仓数 | ${(book.positions || []).length} |
| 未完成订单 | ${(book.openOrders || []).length} |
| 实盘 | 关闭（本页不下单） |
| asOf | ${book.asOf || '未知'} |

${book.note ? `${book.note}\n` : ''}
## 今日结论

1. **${stance}**。${headline}
2. **不把纸上 0C 当成这本账。** 0C 是独立 $5k 实验仓；本页只反映 Robinhood Agentic 实盘。
3. **NO TRADE 合法。** 没有 A 级不对称赔率就空着或继续拿，不为有现金而交易。

## 持仓

| 代码 | 数量 | 成本 | 现价 | 市值 | 浮盈亏 | 策略 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${positionRows(book, cycles) || '| — |  |  |  |  |  | 空仓 |'}

## 未完成订单

| 代码 | 方向 | 数量 | 价格 | 状态 | 订单号 |
| --- | --- | ---: | ---: | --- | --- |
${orderRows(book) || '| — | 无未完成订单 |  |  |  |  |'}

## 已成交（若扫描传入当天 fills）

| 代码 | 方向 | 数量 | 均价 | 订单号 | 备注 |
| --- | --- | ---: | ---: | --- | --- |
${fillRows || '| — |  |  |  |  | 当日扫描未带成交 |'}

## 不操作条件

- 持仓档案过期时禁止编造买卖
- 用主账户或纸上 0C 冒充本账户
- 高开追涨、摊低亏损仓、裸卖或算不清最大亏损
`;
  return {
    date,
    title: 'Agentic 小账户日报',
    stance,
    headline,
    nav: nav == null ? null : round2(nav),
    cash: cash == null ? null : round2(cash),
    buyingPower: bp == null ? null : round2(bp),
    stocks: stocks ? round2(stocks) : 0,
    positions: (book.positions || []).length,
    stale,
    asOf: book.asOf || null,
    markdown: md
  };
}

export async function writeAgenticNarrative({ date, fills = [], preserveAuthored = false } = {}) {
  const day = date || todayStamp();
  if (preserveAuthored) {
    for (const dir of [OBSIDIAN_DAILY, REPORTS_DIR]) {
      try {
        const raw = await readFile(join(dir, `${day}.md`), 'utf8');
        if (raw.trim() && parseFrontmatter(raw).meta.source !== 'engine-snapshot') {
          return { date: day, preserved: true, message: `${day} 已有人工 / Council 叙事，已保留原文；手动更新仅重建引擎账户快照。` };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const config = await loadAccounts('grok');
  const account = accountById(config, 'agentic');
  const book = await loadHoldings(account);
  const stale = !holdingsFreshness(book, day).fresh;
  const heldSymbols = (book.positions || []).map((row) => row.symbol).filter(Boolean);
  let cycles = {};
  try {
    if (heldSymbols.length) {
      const lastBySymbol = Object.fromEntries(heldSymbols.map((s) => {
        const pos = (book.positions || []).find((row) => row.symbol === s);
        return [s, pos?.last ?? null];
      }));
      const cycleBook = await loadCycleBook(heldSymbols, { lastBySymbol, concurrency: 4 });
      cycles = cycleBook.bySymbol || {};
    }
  } catch {
    cycles = {};
  }
  const report = {
    ...renderAgenticNarrative({ date: day, book: { ...book, asOf: book.dataAsOf || book.asOf }, stale, fills, cycles }),
    generatedAt: new Date().toISOString(),
    liveTrading: false
  };
  await mkdir(OBSIDIAN_DAILY, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(join(OBSIDIAN_DAILY, `${day}.md`), report.markdown, 'utf8');
  await writeFile(join(OBSIDIAN_DAILY, `${day}.json`), `${JSON.stringify({ ...report, markdown: undefined }, null, 2)}\n`, 'utf8');
  await writeFile(join(REPORTS_DIR, `${day}.md`), report.markdown, 'utf8');
  await writeFile(join(REPORTS_DIR, `${day}.json`), `${JSON.stringify({ ...report, markdown: undefined }, null, 2)}\n`, 'utf8');
  return report;
}
