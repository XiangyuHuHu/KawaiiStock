import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ACTUALS_DIR, DATA_DIR, actualsDir, todayStamp } from './paths.js';
import { parseFrontmatter, renderMarkdown } from './markdown.js';

const ACCOUNT_IDS = ['main', 'tactical', 'agentic'];
const SIDES = new Set(['BUY', 'SELL', 'TRIM', 'ADD']);
const FILLED_STATUSES = new Set(['filled', 'partially_filled', 'executed']);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function localDir(advisor) {
  return join(ACTUALS_DIR, advisor === 'chatgpt' ? 'chatgpt' : 'grok');
}

function emptyDay(date, advisor) {
  return {
    date,
    advisor: advisor === 'chatgpt' ? 'chatgpt' : 'grok',
    liveTrading: false,
    type: 'actual-operation',
    entries: []
  };
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function accountLabel(id) {
  if (id === 'main') return '主账户';
  if (id === 'tactical') return '战术';
  if (id === 'agentic') return 'Agentic';
  return id || '—';
}

function renderActualMarkdown(payload) {
  const advisorLabel = payload.advisor === 'chatgpt' ? 'ChatGPT' : 'Grok';
  const rows = (payload.entries || []).map((row) => (
    `| ${String(row.createdAt || '').slice(0, 19).replace('T', ' ')} | ${accountLabel(row.accountId)} | ${row.symbol} | ${row.side} | ${row.qty ?? ''} | ${money(row.price)} | ${row.source || 'manual'} | ${row.orderId || ''} | ${row.note || ''} |`
  )).join('\n');
  return `---
title: ${advisorLabel} 实际操作
date: ${payload.date}
advisor: ${payload.advisor}
liveTrading: false
type: actual-operation
---

# ${payload.date} ${advisorLabel} 实际操作

> 只记当天真实做过的交易。战术 / Agentic 可从 Robinhood 已成交扫描写入。主账户无接口，只能手改。草稿不写入。

| 时间 | 账户 | 代码 | 方向 | 数量 | 价格 | 来源 | 订单号 | 备注 |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
${rows || '| — |  |  |  |  |  |  |  | 当日无实际成交 |'}
`;
}

async function saveDay(payload) {
  payload.liveTrading = false;
  payload.type = 'actual-operation';
  const dir = actualsDir(payload.advisor);
  const local = localDir(payload.advisor);
  await mkdir(dir, { recursive: true });
  await mkdir(local, { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = renderActualMarkdown(payload);
  await writeFile(join(dir, `${payload.date}.json`), json, 'utf8');
  await writeFile(join(dir, `${payload.date}.md`), md, 'utf8');
  await writeFile(join(local, `${payload.date}.json`), json, 'utf8');
  return payload;
}

export async function loadActualDay(advisor, date) {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const json = (await readJson(join(actualsDir(who), `${date}.json`)))
    || (await readJson(join(localDir(who), `${date}.json`)));
  if (Array.isArray(json?.entries)) return json;
  return emptyDay(date, who);
}

export async function loadActualFiles(advisor = 'grok') {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const dir = actualsDir(who);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const dates = new Set(
    names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.(md|json)$/.test(name))
      .map((name) => basename(name).replace(/\.(md|json)$/, ''))
  );
  const out = [];
  for (const date of [...dates].sort().reverse()) {
    const payload = await loadActualDay(who, date);
    let html = '';
    try {
      const raw = await readFile(join(dir, `${date}.md`), 'utf8');
      const { body } = parseFrontmatter(raw);
      html = renderMarkdown(body);
    } catch {
      html = renderMarkdown(renderActualMarkdown(payload).replace(/^---[\s\S]*?---\n/, ''));
    }
    out.push({ date, html, json: payload, entries: payload.entries || [] });
  }
  return out;
}

function normalizeSide(value) {
  const raw = String(value || 'BUY').trim().toUpperCase();
  if (SIDES.has(raw)) return raw;
  if (raw.includes('SELL') || raw === 'CREDIT') return 'SELL';
  if (raw.includes('BUY') || raw === 'DEBIT') return 'BUY';
  return '';
}

export function fillDate(row) {
  const raw = row?.filledAt || row?.lastTransactionAt || row?.last_transaction_at || row?.createdAt || row?.created_at;
  if (!raw) return todayStamp();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? todayStamp() : todayStamp(date);
}

export function fillFromBrokerOrder(order, accountId) {
  if (!order || !accountId) return null;
  const state = String(order.state || order.brokerStatus || '').toLowerCase();
  if (state && !FILLED_STATUSES.has(state)) return null;
  const legs = order.legs || [];
  const firstLeg = legs[0] || {};
  const exec = (order.executions || firstLeg.executions || [])[0] || {};
  const symbol = String(order.symbol || order.chain_symbol || firstLeg.symbol || '').trim().toUpperCase();
  const side = normalizeSide(firstLeg.side || order.side || order.direction);
  const qty = Number(order.cumulative_quantity || order.processed_quantity || order.quantity || firstLeg.quantity);
  const price = Number(order.average_price || exec.price || order.price || order.processed_premium);
  const filledAt = order.last_transaction_at || exec.timestamp || order.updated_at || order.created_at;
  if (!symbol || !side || !(qty > 0) || !(price >= 0)) return null;
  const opt = firstLeg.expiration_date
    ? `${firstLeg.expiration_date} ${Number(firstLeg.strike_price)} ${firstLeg.option_type || ''}`.trim()
    : '';
  const agent = order.placed_agent && order.placed_agent !== 'user' ? ` · ${order.placed_agent}` : '';
  return {
    accountId,
    symbol,
    side,
    qty,
    price,
    orderId: order.id || order.orderId || null,
    createdAt: filledAt || new Date().toISOString(),
    brokerStatus: 'filled',
    filled: true,
    draft: false,
    source: 'robinhood',
    note: [opt ? `期权 ${opt}` : '', order.opening_strategy || order.closing_strategy || '', agent.replace(/^ · /, '')].filter(Boolean).join(' · ')
  };
}

function asFill(row, accountId) {
  if (!row) return null;
  if (row.symbol && (row.price != null || row.avgPrice != null) && (row.qty != null || row.quantity != null)) {
    return {
      accountId: row.accountId || row.account || accountId,
      symbol: String(row.symbol).toUpperCase(),
      side: normalizeSide(row.side || row.action),
      qty: Number(row.qty ?? row.quantity),
      price: Number(row.price ?? row.avgPrice ?? row.average_price),
      orderId: row.orderId || row.id || null,
      createdAt: row.createdAt || row.filledAt || row.last_transaction_at || row.created_at,
      brokerStatus: row.brokerStatus || row.state || 'filled',
      filled: true,
      draft: false,
      source: row.source || 'robinhood',
      note: row.note || ''
    };
  }
  return fillFromBrokerOrder(row, row.accountId || row.account || accountId);
}

export function extractFillsFromScans(scans = {}) {
  const out = [];
  for (const accountId of ['tactical', 'agentic']) {
    const scan = scans[accountId] || {};
    const rows = [
      ...(scan.fills || []),
      ...(scan.orders || []),
      ...(scan.filledOrders || []),
      ...((scan.openOrders || []).filter((row) => FILLED_STATUSES.has(String(row.state || row.status || '').toLowerCase())))
    ];
    for (const row of rows) {
      const fill = asFill(row, accountId);
      if (fill?.symbol && fill.side && fill.qty > 0 && fill.price >= 0) out.push(fill);
    }
  }
  const seen = new Set();
  return out.filter((row) => {
    const key = row.orderId || `${row.accountId}:${row.symbol}:${row.createdAt}:${row.qty}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeEntry(body, source) {
  const symbol = String(body.symbol || '').trim().toUpperCase();
  const side = normalizeSide(body.side || body.action || 'BUY');
  const qty = Number(body.qty ?? body.quantity ?? body.cumulative_quantity);
  const price = Number(body.price ?? body.avgPrice ?? body.fillPrice ?? body.average_price);
  const accountId = ACCOUNT_IDS.includes(body.accountId) ? body.accountId : (ACCOUNT_IDS.includes(body.account) ? body.account : null);
  if (!symbol) return { error: 'missing-symbol', message: '需要代码。' };
  if (!SIDES.has(side)) return { error: 'bad-side', message: '方向只接受 BUY / SELL / TRIM / ADD。' };
  if (!Number.isFinite(qty) || qty <= 0) return { error: 'bad-qty', message: '数量必须大于 0。' };
  if (!Number.isFinite(price) || price < 0) return { error: 'bad-price', message: '需要成交价格。' };
  if (!accountId) return { error: 'bad-account', message: '账户必须是 main / tactical / agentic。' };
  return {
    id: body.id || crypto.randomUUID(),
    accountId,
    symbol,
    side,
    qty,
    price,
    note: String(body.note || '').trim(),
    source,
    filled: true,
    draft: false,
    orderId: body.orderId ? String(body.orderId) : null,
    brokerStatus: body.brokerStatus ? String(body.brokerStatus) : (source === 'agentic' ? 'filled' : 'manual'),
    createdAt: body.createdAt || new Date().toISOString()
  };
}

export async function appendActual(body, { source = 'manual' } = {}) {
  const advisor = body.advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const date = body.date || todayStamp();
  const entry = normalizeEntry(body, source);
  if (entry.error) return { ok: false, ...entry };
  const day = await loadActualDay(advisor, date);
  if (!day.entries) day.entries = [];
  day.entries.push(entry);
  await saveDay(day);
  await syncLiveAfterGrokWrite(advisor);
  return { ok: true, liveTrading: false, date, advisor, entry, day };
}

export async function recordAgenticFill(body) {
  if (body?.draft === true || body?.isDraft === true) {
    return { ok: false, error: 'draft-not-actual', message: '草稿不能写入实际操作。' };
  }
  if (body?.filled === false) {
    return { ok: false, error: 'not-filled', message: '只有成交成功才写入实际操作。' };
  }
  const status = String(body?.brokerStatus || body?.status || '').toLowerCase();
  const filled = body?.filled === true || FILLED_STATUSES.has(status);
  if (!filled) {
    return { ok: false, error: 'not-filled', message: '只有成交成功才写入实际操作。不要把草稿写成实际。' };
  }
  if (!body?.orderId) {
    return { ok: false, error: 'missing-order-id', message: 'Agentic 自动录入需要真实 orderId。' };
  }
  const accountId = body.accountId || body.account || 'agentic';
  if (accountId !== 'agentic') {
    return { ok: false, error: 'agentic-only', message: '自动录入只记 Agentic 账户成交。其他账户请网页手改。' };
  }
  return appendActual({
    ...body,
    advisor: body.advisor === 'chatgpt' ? 'chatgpt' : 'grok',
    accountId: 'agentic',
    filled: true,
    draft: false
  }, { source: 'agentic' });
}

export async function removeActual({ advisor, date, id }) {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const day = await loadActualDay(who, date);
  const before = day.entries.length;
  day.entries = day.entries.filter((row) => row.id !== id);
  if (day.entries.length === before) {
    return { ok: false, error: 'not-found', message: '没有这条实际操作。' };
  }
  await saveDay(day);
  return { ok: true, liveTrading: false, date, advisor: who, day };
}

export async function ensureActualsDirs() {
  for (const advisor of ['grok', 'chatgpt']) {
    await mkdir(actualsDir(advisor), { recursive: true });
    await mkdir(localDir(advisor), { recursive: true });
  }
}

function isDraftFill(row) {
  if (row?.draft === true || row?.isDraft === true) return true;
  if (row?.filled === false) return true;
  const status = String(row?.brokerStatus || row?.status || '').toLowerCase();
  if (status && !FILLED_STATUSES.has(status) && status !== 'manual') return true;
  return false;
}

/** 每日任务第 4 步：无成交则写「无实际成交」；草稿不写入。 */
export async function recordDailyActuals({ date, advisor = 'grok', fills = [] } = {}) {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const dayDate = date || todayStamp();
  await ensureActualsDirs();
  const day = await loadActualDay(who, dayDate);
  const realFills = (fills || []).filter((row) => !isDraftFill(row));
  const existingIds = new Set((day.entries || []).map((row) => row.orderId).filter(Boolean));
  let added = 0;
  let skippedDraft = (fills || []).length - realFills.length;
  for (const row of realFills) {
    if (row.orderId && existingIds.has(String(row.orderId))) continue;
    const result = await appendActual({
      ...row,
      advisor: who,
      date: dayDate,
      filled: true,
      draft: false
    }, { source: row.source || (row.orderId ? 'robinhood' : 'manual') });
    if (result.ok) {
      added += 1;
      if (result.entry?.orderId) existingIds.add(result.entry.orderId);
    }
  }
  const latest = await loadActualDay(who, dayDate);
  if (!(latest.entries || []).length) {
    await saveDay(latest);
  }
  await syncLiveAfterGrokWrite(who);
  return {
    ok: true,
    liveTrading: false,
    date: dayDate,
    advisor: who,
    added,
    skippedDraft,
    empty: !(latest.entries || []).length,
    message: (latest.entries || []).length ? `已记 ${latest.entries.length} 笔实际成交` : '无实际成交',
    day: latest
  };
}

async function syncLiveAfterGrokWrite(who) {
  if (who !== 'grok') return;
  try {
    const { syncLiveActualsPnl } = await import('./risk/pnl.js');
    await syncLiveActualsPnl();
  } catch {
    /* 回写失败不挡实际操作落盘 */
  }
}

export async function loadScanFills() {
  const collected = [];
  const broker = await readJson(join(DATA_DIR, 'broker-fills.json'));
  if (Array.isArray(broker)) collected.push(...broker);
  else if (Array.isArray(broker?.fills)) collected.push(...broker.fills);
  const scans = await readJson(join(DATA_DIR, 'scans-today.json'));
  if (scans) {
    collected.push(...(scans.fills || []));
    collected.push(...extractFillsFromScans(scans.scans || {}));
  }
  const seen = new Set();
  return collected.map((row) => asFill(row, row.accountId || row.account)).filter((row) => {
    if (!row?.symbol || !row.side || !(row.qty > 0)) return false;
    const key = row.orderId || `${row.accountId}:${row.symbol}:${row.createdAt}:${row.qty}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function importBrokerFills(fills = [], { advisor = 'grok' } = {}) {
  const byDate = {};
  for (const row of fills) {
    const mapped = row.orderId || row.symbol
      ? {
          ...row,
          accountId: row.accountId || row.account,
          createdAt: row.createdAt || row.filledAt || row.last_transaction_at
        }
      : fillFromBrokerOrder(row, row.accountId || row.account);
    if (!mapped) continue;
    const date = fillDate(mapped);
    (byDate[date] ||= []).push(mapped);
  }
  const days = [];
  for (const date of Object.keys(byDate).sort()) {
    days.push(await recordDailyActuals({ date, advisor, fills: byDate[date] }));
  }
  return {
    ok: true,
    liveTrading: false,
    added: days.reduce((sum, row) => sum + (row.added || 0), 0),
    dates: days.map((row) => ({ date: row.date, added: row.added, total: row.day?.entries?.length || 0 })),
    message: days.length
      ? `已从 Robinhood 成交写入 ${days.reduce((sum, row) => sum + (row.added || 0), 0)} 笔`
      : '没有可写入的成交'
  };
}
