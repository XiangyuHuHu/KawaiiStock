import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asOfStamp, DATA_DIR, OBSIDIAN_HOLDINGS, recsDir, strategyRoot, todayStamp } from './paths.js';

export async function loadConfig() {
  return JSON.parse(await readFile(join(DATA_DIR, 'accounts.json'), 'utf8'));
}

export function deskById(config, id = 'grok') {
  return config.desks.find((row) => row.id === id) || config.desks[0];
}

export async function loadAccounts(deskId = 'grok') {
  const config = await loadConfig();
  const desk = deskById(config, deskId);
  return {
    ...config,
    desk,
    accounts: desk.accounts
  };
}

export function accountById(config, id) {
  const accounts = config.accounts || deskById(config, config.desk?.id).accounts;
  return accounts.find((row) => row.id === id) || null;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export function holdingsPaths(account) {
  const name = `${account.holdingsStem}.json`;
  return {
    vault: join(OBSIDIAN_HOLDINGS, name),
    local: join(DATA_DIR, 'holdings', name),
    markdown: join(OBSIDIAN_HOLDINGS, `${account.holdingsStem}.md`)
  };
}

function parseMoney(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function headerIndex(header, ...needles) {
  return header.findIndex((cell) => needles.some((needle) => cell.includes(needle)));
}

function parseHoldingsMarkdown(raw, account) {
  const text = String(raw ?? '').replace(/\r/g, '');
  const asOfMatch = text.match(/最新可靠[^：\n]*[：:]\s*(\d{4}-\d{2}-\d{2})/)
    || text.match(/data_asof:\s*(\d{4}-\d{2}-\d{2}T[^\s]+)/)
    || text.match(/data_asof:\s*(\d{4}-\d{2}-\d{2})/)
    || text.match(/updated:\s*(\d{4}-\d{2}-\d{2}[^\n]*)/)
    || text.match(/更新时间：(\d{4}-\d{2}-\d{2})/);
  const cashMatch = text.match(/\|\s*现金[^|]*\|\s*\$?([0-9,]+\.?\d*)/)
    || text.match(/Cash[^$]*\$([0-9,]+\.?\d*)/i)
    || text.match(/现金[：:]\s*\$?([0-9,]+\.?\d*)/);
  const costMatch = text.match(/持仓 Cost 合计[：:]\s*\$([0-9,]+\.?\d*)/)
    || text.match(/股票\s*\/\s*ETF 成本合计约\s*`?\$([0-9,]+\.?\d*)/);
  const marketMatch = text.match(/\|\s*股票\s*\|\s*\$?([0-9,]+\.?\d*)/)
    || text.match(/股票市值[：:]\s*约?\s*\$([0-9,]+\.?\d*)/);
  const equityMatch = text.match(/\|\s*账户总值\s*\|\s*\$?([0-9,]+\.?\d*)/)
    || text.match(/账户总值[：:]\s*\$?([0-9,]+\.?\d*)/);
  const lines = text.split('\n');
  const positions = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\|/.test(lines[i]) || i + 1 >= lines.length || !/^\|?\s*:?-/.test(lines[i + 1])) continue;
    const header = lines[i].replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (!header.some((cell) => cell.includes('代码'))) continue;
    const qtyIdx = headerIndex(header, '数量', '股数');
    const nameIdx = headerIndex(header, '公司', '证券', '名称');
    const roleIdx = headerIndex(header, '定位');
    const themeIdx = headerIndex(header, '主题');
    const costIdx = headerIndex(header, 'Cost', '成本合计');
    const avgIdx = headerIndex(header, '平均成本', '平均', '快照价');
    const lastIdx = headerIndex(header, '参考价', '现价');
    const mvIdx = headerIndex(header, '估算市值', '市值');
    const pnlIdx = headerIndex(header, '浮盈亏', '盈亏');
    i += 2;
    while (i < lines.length && /^\|/.test(lines[i])) {
      const cells = lines[i].replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      i += 1;
      const symbol = String(cells[0] || '').replace(/`/g, '').toUpperCase();
      if (!symbol || symbol === '—' || symbol === '-') continue;
      const qty = parseMoney(qtyIdx >= 0 ? cells[qtyIdx] : cells[1]);
      positions.push({
        symbol,
        name: nameIdx >= 0 ? cells[nameIdx] : symbol,
        qty,
        role: roleIdx >= 0 ? cells[roleIdx] : '',
        theme: themeIdx >= 0 ? cells[themeIdx] : '',
        cost: costIdx >= 0 ? parseMoney(cells[costIdx]) : null,
        avgCost: avgIdx >= 0 ? parseMoney(cells[avgIdx]) : null,
        last: lastIdx >= 0 ? parseMoney(cells[lastIdx]) : null,
        marketValue: mvIdx >= 0 ? parseMoney(cells[mvIdx]) : null,
        unrealizedPnl: pnlIdx >= 0 ? parseMoney(cells[pnlIdx]) : null
      });
    }
    break;
  }
  return {
    id: account.id,
    label: account.label,
    source: account.source,
    asOf: asOfMatch?.[1] || null,
    cash: cashMatch ? parseMoney(cashMatch[1]) : null,
    costTotal: costMatch ? parseMoney(costMatch[1]) : (marketMatch ? parseMoney(marketMatch[1]) : null),
    equity: equityMatch ? parseMoney(equityMatch[1]) : null,
    positions,
    missing: positions.length === 0,
    configured: true,
    note: account.holdingsKind === 'strategy-not-book'
      ? '这份文件是策略副本，不是持仓表。ChatGPT Agentic 没有独立持仓档案。'
      : '从 ChatGPT 对照持仓 Markdown 解析。只读。'
  };
}

export async function loadHoldings(account) {
  if (account.holdingsKind === 'strategy-not-book') {
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      asOf: null,
      cash: null,
      costTotal: null,
      positions: [],
      missing: true,
      configured: false,
      note: 'ChatGPT 的 `03_5000美元_Agentic自动交易策略.md` 是策略手册副本，没有持仓表。'
    };
  }
  if (account.holdingsFile) {
    const jsonName = account.holdingsFile.replace(/\.md$/i, '.json');
    const fromJson = await readJson(join(OBSIDIAN_HOLDINGS, jsonName));
    if (fromJson && Array.isArray(fromJson.positions)) {
      return annotateHoldings(account, fromJson);
    }
    try {
      const raw = await readFile(join(OBSIDIAN_HOLDINGS, account.holdingsFile), 'utf8');
      return parseHoldingsMarkdown(raw, account);
    } catch {
      return {
        id: account.id,
        label: account.label,
        source: account.source,
        asOf: null,
        cash: null,
        costTotal: null,
        positions: [],
        missing: true,
        configured: false,
        note: `未找到 ${account.holdingsFile}`
      };
    }
  }
  const paths = holdingsPaths(account);
  const data = (await readJson(paths.vault)) || (await readJson(paths.local));
  if (!data) {
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      asOf: null,
      cash: null,
      costTotal: null,
      positions: [],
      missing: true,
      configured: false
    };
  }
  return annotateHoldings(account, data);
}

export function holdingsFreshness(book, date = todayStamp()) {
  if (!book || book.configured === false) return { fresh: false, stale: false, configured: false };
  if (book.missing) return { fresh: false, stale: true, configured: true };
  if (book.pricesOk === true && asOfStamp(book.priceAsOf) === date) return { fresh: true, stale: false, configured: true };
  if (book.scanStatus === 'unavailable' || book.stale === true) return { fresh: false, stale: true, configured: true };
  const day = asOfStamp(book.dataAsOf || book.asOf);
  if (!day) return { fresh: false, stale: true, configured: true };
  return { fresh: day === date, stale: day !== date, configured: true };
}

const QUOTE_SYMBOL = /^[A-Z][A-Z0-9.-]{0,12}$/;

function optionMarkKey(row) {
  return [row.symbol, row.expiration, String(row.type || '').toLowerCase(), Number(row.strike)].join('|');
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 用公开行情改参考价。股数不动。零价值占位代码缺报价不算缺口。 */
export function applyHoldingQuotes(book, quotes = {}, { date = todayStamp(), now = new Date().toISOString(), optionMarks = {} } = {}) {
  const positions = (book.positions || []).map((row) => {
    const quote = quotes[row.symbol];
    if (!quote?.ok || !(Number(quote.last) > 0)) return row;
    const last = Number(quote.last);
    const qty = Number(row.qty);
    const avg = Number(row.avgCost);
    return {
      ...row,
      last,
      marketValue: Number.isFinite(qty) ? roundMoney(qty * last) : row.marketValue,
      unrealizedPnl: Number.isFinite(qty) && Number.isFinite(avg) ? roundMoney((last - avg) * qty) : row.unrealizedPnl
    };
  });
  const optionPositions = (book.optionPositions || []).map((row) => {
    if (row.expiration && row.expiration < date) return { ...row, estimatedValue: 0, expired: true, quotePriced: true };
    const mark = Number(optionMarks[optionMarkKey(row)]);
    if (!(mark > 0)) return row;
    const qty = Number(row.qty) || 0;
    return { ...row, estimatedValue: roundMoney(mark * 100 * qty), mark, quotePriced: true };
  });
  const missing = positions.filter((row) => {
    const idle = !(Number(row.marketValue) > 0) && !(Number(row.avgCost) > 0) && !(Number(row.last) > 0);
    if (idle || !QUOTE_SYMBOL.test(String(row.symbol || ''))) return false;
    const quote = quotes[row.symbol];
    return !(quote?.ok && Number(quote.last) > 0);
  });
  const openUnpriced = optionPositions.filter((row) => row.expiration && row.expiration >= date && Number(row.qty) && !row.quotePriced);
  const pricesOk = missing.length === 0 && openUnpriced.length === 0;
  const stockValue = positions.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  const optionValue = optionPositions.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0);
  const cash = Number(book.cash || 0);
  const crypto = Number(book.cryptoValue || 0);
  const brokerAsOf = book.asOf || book.dataAsOf || '无';
  return {
    ...book,
    asOf: book.asOf || null,
    dataAsOf: book.dataAsOf || book.asOf || null,
    positions,
    optionPositions,
    optionsValue: pricesOk ? roundMoney(optionValue) : book.optionsValue,
    equity: pricesOk ? roundMoney(stockValue + optionValue) : book.equity,
    totalValue: pricesOk ? roundMoney(cash + stockValue + optionValue + crypto) : book.totalValue,
    priceAsOf: now,
    pricesOk,
    stale: !pricesOk,
    scanStatus: pricesOk ? 'ok' : (book.scanStatus || 'ok'),
    lastScanAttempt: now,
    note: pricesOk
      ? `公开行情已刷新到 ${now}。股数仍是上次券商扫描 ${brokerAsOf}，一键更新不连 Robinhood，不能改数量。`
      : `公开行情没补全（股票缺 ${missing.map((row) => row.symbol).join(', ') || '无'}，期权缺 ${openUnpriced.map((row) => row.symbol).join(', ') || '无'}）。上次券商扫描 ${brokerAsOf}。`
  };
}

async function optionMarksFor(rows, date, optionLoader) {
  const marks = {};
  const open = (rows || []).filter((row) => row.expiration && row.expiration >= date && Number(row.qty));
  const groups = new Map();
  for (const row of open) {
    const key = `${row.symbol}|${row.expiration}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, list] of groups) {
    const [symbol, expiration] = key.split('|');
    const unix = Math.floor(Date.parse(`${expiration}T00:00:00Z`) / 1000);
    let chain;
    try { chain = await optionLoader(symbol, unix); }
    catch { continue; }
    const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
    for (const row of list) {
      const want = String(row.type || '').toLowerCase();
      const hit = legs.find((leg) => Number(leg.strike) === Number(row.strike) && String(leg.type || '').toLowerCase() === want);
      const bid = Number(hit?.bid);
      const ask = Number(hit?.ask);
      const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : Number(hit?.last);
      if (mid > 0) marks[optionMarkKey(row)] = mid;
    }
  }
  return marks;
}

/** 一键更新没有 Robinhood 时，用 Nasdaq 报价把已有持仓的参考价补到今天。 */
export async function refreshHoldingPrices(account, { date = todayStamp(), quoteLoader, optionLoader } = {}) {
  if (account.source === 'manual') return loadHoldings(account);
  const book = await loadHoldings(account);
  const symbols = [...new Set((book.positions || []).map((row) => row.symbol).filter((symbol) => QUOTE_SYMBOL.test(String(symbol || ''))))];
  const load = quoteLoader || (await import('./quotes.js')).loadQuotes;
  let quotes = {};
  try { quotes = symbols.length ? await load(symbols) : {}; }
  catch { quotes = {}; }
  const loader = optionLoader === undefined && (book.optionPositions || []).some((row) => row.expiration && row.expiration >= date)
    ? (await import('./options/market.js')).loadOptionChain
    : optionLoader;
  const optionMarks = loader ? await optionMarksFor(book.optionPositions, date, loader) : {};
  const next = applyHoldingQuotes(book, quotes, { date, optionMarks });
  return saveHoldings(account, next);
}

export function holdingsAge(book, now = new Date()) {
  const day = asOfStamp(book?.dataAsOf || book?.asOf);
  if (!day) return { ageDays: null, asOf: null, label: '快照日期未知，不能当成今日持仓' };
  const today = todayStamp(now);
  const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return { ageDays: null, asOf: day, label: '快照日期未知，不能当成今日持仓' };
  if (ageDays === 0) return { ageDays: 0, asOf: day, label: `快照日期 ${day}` };
  return { ageDays, asOf: day, label: `快照已过 ${ageDays} 天（${day}），不是今日实时` };
}

function annotateHoldings(account, data) {
  const age = holdingsAge(data);
  const ageStale = age.ageDays == null || age.ageDays > 0;
  const broker = account.source === 'robinhood' ? holdingsFreshness(data) : null;
  const stale = broker ? (broker.fresh ? false : (broker.stale || ageStale)) : (Boolean(data.stale) || ageStale);
  return {
    ...data,
    missing: false,
    configured: true,
    stale,
    staleAgeDays: age.ageDays,
    staleLabel: age.label,
    live: account.source === 'robinhood' ? Boolean(broker?.fresh) && data.scanStatus !== 'unavailable' : false
  };
}

function moneyCell(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function holdingsNav(book) {
  const stocks = (book.positions || []).reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  if (book.totalValue != null && Number.isFinite(Number(book.totalValue))) return Number(book.totalValue);
  if (book.cash != null && Number.isFinite(Number(book.cash)) && stocks) return Number(book.cash) + stocks;
  if (book.equity != null && Number.isFinite(Number(book.equity))) return Number(book.equity);
  return null;
}

export function stockMarketValue(book) {
  return (book.positions || []).reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
}

export function renderHoldingsMarkdown(account, book) {
  const stale = book.scanStatus === 'unavailable' || book.stale;
  const rows = (book.positions || []).map((row) => {
    const qty = row.qty ?? '';
    const cost = row.cost != null ? moneyCell(row.cost) : moneyCell(row.marketValue);
    const avg = row.avgCost != null ? `$${Number(row.avgCost).toFixed(2)}` : '';
    const last = row.last != null ? `$${Number(row.last).toFixed(2)}` : '';
    return `| ${row.symbol} | ${row.name || ''} | ${qty} | ${row.role || ''} | ${row.theme || ''} | ${cost} | ${avg} | ${last} |`;
  }).join('\n');
  const optionRows = (book.optionPositions || []).map((row) => (
    `| ${row.symbol || ''} | ${row.side || ''} ${row.type || ''} | ${row.expiration || ''} | ${row.strike ?? ''} | ${row.qty ?? ''} | ${moneyCell(row.estimatedValue ?? row.markPricePerShare)} |`
  )).join('\n');
  const orderRows = (book.openOrders || []).map((row) => (
    `| ${row.symbol || ''} | ${row.side || row.type || ''} | ${row.qty ?? ''} | ${row.price ?? ''} | ${row.status || 'open'} | ${row.orderId || ''} |`
  )).join('\n');

  return `---
title: ${account.label}｜Grok 持仓档案
account: ${account.id}
source: ${account.source}
updated: ${book.asOf || ''}
scanStatus: ${book.scanStatus || (account.source === 'manual' ? 'manual' : 'ok')}
stale: ${stale ? 'true' : 'false'}
type: grok-holdings
---

# ${account.label}｜Grok 持仓档案

${stale ? `> **缺数据：这不是实时持仓。** 上次可靠扫描 ${book.asOf || '无'}。禁止把昨日档案当成今日实时。\n` : ''}
> 来源：${account.source === 'manual' ? '手动维护（无接口，不扫描覆盖）' : (stale ? '上次扫描（已过期/失败）' : 'Robinhood 扫描写入')} · 更新 ${book.asOf || '未知'}
> 现金：${book.cash == null ? '未记录' : moneyCell(book.cash)}
> 账户总值：${holdingsNav(book) == null ? '未记录' : moneyCell(holdingsNav(book))}
> 股票市值：${stockMarketValue(book) ? moneyCell(stockMarketValue(book)) : '未记录'}
> 购买力：${book.buyingPower == null ? '未记录' : moneyCell(book.buyingPower)}
> 持仓成本合计：${book.costTotal == null ? '未记录' : moneyCell(book.costTotal)}

${book.note ? `> ${book.note}\n` : ''}
## 当前持仓

| 代码 | 公司/证券 | 数量 | 当前定位 | 主题 | Cost | 平均成本 | 参考价 |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: |
${rows || '| — | 空仓 |  |  |  |  |  |  |'}

## 期权

| 代码 | 方向 | 到期 | 行权价 | 数量 | 估值 |
| --- | --- | --- | ---: | ---: | ---: |
${optionRows || '| — | 无期权 |  |  |  |  |'}

## 未完成订单

| 代码 | 方向 | 数量 | 价格 | 状态 | 订单号 |
| --- | --- | ---: | ---: | --- | --- |
${orderRows || '| — | 无未完成订单 |  |  |  |  |'}

## 数据规则

- 战术 / Agentic 以最近一次成功的 Robinhood 扫描为准。接口失败要写明缺数据，不得把昨日持仓改标成今日实时。
- 主账户没有接口，只接受本页或网页手改。推荐里可以给动作，每日任务不得覆盖主账户档案。
- 不把过期快照价当成现价。本文件是真实持仓，不是 \`模拟操作/\`。
`;
}

export async function saveHoldings(account, book) {
  const keepAsOf = Object.prototype.hasOwnProperty.call(book, 'asOf');
  const payload = {
    id: account.id,
    label: book.label || account.label,
    source: account.source,
    accountLast4: book.accountLast4 ?? null,
    asOf: keepAsOf ? (book.asOf || null) : new Date().toISOString(),
    dataAsOf: book.dataAsOf ?? null,
    cash: book.cash ?? null,
    costTotal: book.costTotal ?? null,
    buyingPower: book.buyingPower ?? null,
    equity: book.equity ?? book.totalValue ?? null,
    totalValue: book.totalValue ?? book.equity ?? null,
    optionsValue: book.optionsValue ?? null,
    eventContractsValue: book.eventContractsValue ?? null,
    cryptoValue: book.cryptoValue ?? null,
    scanStatus: book.scanStatus || (account.source === 'manual' ? 'manual' : 'ok'),
    stale: Boolean(book.stale),
    priceAsOf: book.priceAsOf ?? null,
    pricesOk: book.pricesOk === true,
    lastScanAttempt: book.lastScanAttempt || null,
    note: book.note || '',
    positions: book.positions || [],
    optionPositions: book.optionPositions || [],
    openOrders: book.openOrders || []
  };
  const paths = holdingsPaths(account);
  await mkdir(OBSIDIAN_HOLDINGS, { recursive: true });
  await mkdir(join(DATA_DIR, 'holdings'), { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const markdown = renderHoldingsMarkdown(account, payload);
  await writeFile(paths.vault, json, 'utf8');
  await writeFile(paths.local, json, 'utf8');
  await writeFile(paths.markdown, markdown, 'utf8');
  return payload;
}

function mapPositions(rows) {
  return (rows || []).map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    name: row.name || row.symbol,
    qty: Number(row.qty ?? row.quantity ?? 0),
    role: row.role || '扫描持仓',
    theme: row.theme || '',
    cost: row.cost ?? row.marketValue ?? null,
    avgCost: row.avgCost ?? row.averageCost ?? null,
    last: row.last ?? row.price ?? null,
    marketValue: row.marketValue ?? null,
    unrealizedPnl: row.unrealizedPnl ?? null
  })).filter((row) => row.symbol);
}

function importNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function importSymbol(row) {
  const raw = row?.symbol || row?.ticker || row?.chain_symbol || row?.instrument?.symbol || row?.instrument?.symbol_code || '';
  const symbol = String(raw).trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,12}$/.test(symbol) ? symbol : '';
}

export function canImportHoldings(account) {
  return Boolean(account) && (account.id === 'agentic' || account.source !== 'manual');
}

/** 把研究台 JSON 或 Robinhood 持仓导出收成同一份档案。不发送订单。 */
export function normalizeHoldingsImport(raw) {
  const body = Array.isArray(raw) ? { positions: raw } : (raw && typeof raw === 'object' ? raw : {});
  const equity = body.positions || body.results || body.equity_positions || body.equityPositions || [];
  const options = body.optionPositions || body.option_positions || body.options || [];
  const skipped = [];
  const positions = [];
  for (const row of equity) {
    if (!row || typeof row !== 'object') continue;
    const symbol = importSymbol(row);
    const qty = importNumber(row.qty ?? row.quantity ?? row.shares ?? row.shares_available_for_sells);
    if (!symbol || !(qty > 0)) {
      skipped.push(symbol || '无代码');
      continue;
    }
    positions.push({
      symbol,
      name: row.name || row.simple_name || row.instrument?.simple_name || symbol,
      qty,
      role: row.role || '导入持仓',
      theme: row.theme || '',
      cost: importNumber(row.cost ?? row.cost_basis),
      avgCost: importNumber(row.avgCost ?? row.average_buy_price ?? row.average_cost ?? row.avg_price),
      last: importNumber(row.last ?? row.price ?? row.quote?.last ?? row.quote?.last_trade_price),
      marketValue: importNumber(row.marketValue ?? row.equity ?? row.market_value),
      unrealizedPnl: importNumber(row.unrealizedPnl ?? row.unrealized_pl)
    });
  }
  const optionPositions = [];
  for (const row of options) {
    if (!row || typeof row !== 'object') continue;
    const symbol = importSymbol(row);
    const qty = importNumber(row.qty ?? row.quantity);
    if (!symbol || !(qty > 0)) continue;
    optionPositions.push({
      symbol,
      type: String(row.type || row.option_type || '').toLowerCase(),
      expiration: row.expiration || row.expiration_date || null,
      strike: importNumber(row.strike ?? row.strike_price),
      qty,
      side: row.side || 'long'
    });
  }
  const asOf = body.asOf || body.dataAsOf || body.updated_at || body.updatedAt || body.exportedAt
    || equity.find((row) => row?.updated_at || row?.updatedAt)?.updated_at
    || equity.find((row) => row?.updated_at || row?.updatedAt)?.updatedAt
    || null;
  return {
    positions,
    optionPositions,
    openOrders: [],
    skipped,
    asOf,
    cash: importNumber(body.cash ?? body.cash_available ?? body.portfolio_cash ?? body.equity?.cash),
    equity: importNumber(body.equity ?? body.totalValue ?? body.total_value ?? body.portfolio_value),
    buyingPower: importNumber(body.buyingPower ?? body.buying_power)
  };
}

export async function importHoldings(account, raw, now = new Date()) {
  if (!canImportHoldings(account)) {
    throw new Error('主账户请用手改。Agentic 可以导入持仓 JSON，不会下单。');
  }
  const parsed = normalizeHoldingsImport(raw);
  if (!parsed.positions.length && !parsed.optionPositions.length) {
    throw new Error(parsed.skipped.length ? '文件里没有可识别的代码和数量。' : '文件里没有持仓。');
  }
  const age = holdingsAge({ asOf: parsed.asOf, dataAsOf: parsed.asOf }, now);
  const dated = age.ageDays != null;
  const stale = !dated || age.ageDays > 0;
  const label = dated ? age.label : '导入文件没有可用日期，年龄未知，不是今日实时';
  const saved = await saveHoldings(account, {
    asOf: parsed.asOf || null,
    dataAsOf: parsed.asOf || null,
    cash: parsed.cash,
    equity: parsed.equity,
    totalValue: parsed.equity,
    buyingPower: parsed.buyingPower,
    scanStatus: 'imported',
    stale,
    note: `${label}。已导入 ${parsed.positions.length} 只股票${parsed.optionPositions.length ? `、${parsed.optionPositions.length} 条期权` : ''}。这是只读快照，不下单。${parsed.skipped.length ? `跳过 ${parsed.skipped.length} 条无代码或数量为 0 的记录。` : ''}`,
    positions: parsed.positions,
    optionPositions: parsed.optionPositions,
    openOrders: []
  });
  return annotateHoldings(account, saved);
}

export async function applyScan(account, scan) {
  if (account.source === 'manual') {
    throw new Error('主账户不接受扫描写入，请用手改。');
  }
  return saveHoldings(account, {
    asOf: scan.asOf || new Date().toISOString(),
    dataAsOf: scan.dataAsOf || scan.asOf || new Date().toISOString(),
    accountLast4: scan.accountLast4 || null,
    cash: scan.cash ?? null,
    costTotal: scan.costTotal ?? null,
    buyingPower: scan.buyingPower ?? null,
    equity: scan.equity ?? scan.nav ?? scan.totalValue ?? null,
    totalValue: scan.totalValue ?? scan.equity ?? scan.nav ?? null,
    optionsValue: scan.optionsValue ?? null,
    eventContractsValue: scan.eventContractsValue ?? null,
    cryptoValue: scan.cryptoValue ?? null,
    scanStatus: 'ok',
    stale: false,
    lastScanAttempt: new Date().toISOString(),
    note: scan.note || '由 Robinhood 扫描覆盖。',
    positions: mapPositions(scan.positions),
    optionPositions: scan.optionPositions || [],
    openOrders: scan.openOrders || scan.orders || []
  });
}

/** 本机没扫到当天：保留仓位和 asOf，只把档案标成过期。 */
export async function markHoldingsStale(account, { reason } = {}) {
  if (account.source === 'manual') return loadHoldings(account);
  const book = await loadHoldings(account);
  if (book.scanStatus === 'unavailable') return book;
  const lastAsOf = book.asOf || book.dataAsOf || null;
  return saveHoldings(account, {
    ...book,
    asOf: lastAsOf,
    dataAsOf: book.dataAsOf || lastAsOf,
    scanStatus: book.scanStatus || 'ok',
    stale: true,
    lastScanAttempt: new Date().toISOString(),
    note: reason || `缺数据：本机未覆盖持仓。上次可靠扫描 ${lastAsOf || '无'}。禁止把昨日档案当成今日实时。`,
    positions: book.positions || [],
    optionPositions: book.optionPositions || [],
    openOrders: book.openOrders || []
  });
}

/** 接口失败：保留上次仓位，写明缺数据，不把 asOf 改成今天。 */
export async function markScanUnavailable(account, { reason, date } = {}) {
  if (account.source === 'manual') {
    throw new Error('主账户不接受扫描写入。');
  }
  const book = await loadHoldings(account);
  const lastAsOf = book.asOf || book.dataAsOf || null;
  return saveHoldings(account, {
    ...book,
    asOf: lastAsOf,
    dataAsOf: book.dataAsOf || lastAsOf,
    scanStatus: 'unavailable',
    stale: true,
    lastScanAttempt: new Date().toISOString(),
    note: `缺数据：${reason || 'Robinhood 接口失败'}。上次可靠扫描 ${lastAsOf || '无'}。这不是实时持仓，禁止把昨日档案当成今日实时。`,
    positions: book.positions || [],
    optionPositions: book.optionPositions || [],
    openOrders: book.openOrders || []
  });
}

export async function loadStrategy(account, desk = null) {
  const { parseFrontmatter, renderMarkdown } = await import('./markdown.js');
  const vault = desk?.vault || (account.holdingsFile ? 'chatgpt' : 'grok');
  const path = join(strategyRoot(vault), account.strategyFile);
  const local = join(DATA_DIR, '..', 'reports', account.strategyFile);
  for (const candidate of [path, local]) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      return { path: candidate, meta, body, html: renderMarkdown(body), error: null };
    } catch {
      continue;
    }
  }
  return { path: null, meta: {}, body: '', html: '', error: 'strategy-missing' };
}

export async function ensureRecsDir(advisor = 'grok') {
  await mkdir(recsDir(advisor), { recursive: true });
}
