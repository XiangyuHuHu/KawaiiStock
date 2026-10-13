import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { recsDir, SIM_DIR, simVaultDir, todayStamp } from './paths.js';
import { loadActualFiles } from './actuals.js';

const ACCOUNT_IDS = ['main', 'tactical', 'agentic'];
const TRADE = new Set(['BUY', 'ADD', 'SELL', 'TRIM', 'EXIT']);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function last4(value) {
  return String(value || '').replace(/\D/g, '').slice(-4);
}

function accountIdForOrder(order, json) {
  const key = last4(order.account);
  if (!key) return null;
  for (const book of json.accounts || []) {
    if (last4(book.accountLast4) === key) return book.id;
  }
  if (key === '7983') return 'agentic';
  if (key === '3469') return 'tactical';
  return null;
}

function orderAction(order) {
  const instrument = String(order.instrument || 'stock').toLowerCase();
  if (instrument && !['stock', 'etf', '2x-etf'].includes(instrument)) return 'OPTION';
  const side = String(order.side || '').toLowerCase();
  if (side.includes('buy')) return 'BUY';
  if (side.includes('sell')) return 'TRIM';
  return 'WAIT';
}

function recSide(action) {
  const raw = String(action || '').toUpperCase();
  if (raw === 'BUY' || raw === 'ADD') return 'buy';
  if (raw === 'SELL' || raw === 'EXIT' || raw === 'TRIM') return 'sell';
  return '';
}

function actualSide(side) {
  const raw = String(side || '').toUpperCase();
  if (raw === 'BUY' || raw === 'ADD') return 'buy';
  if (raw === 'SELL' || raw === 'TRIM' || raw === 'EXIT') return 'sell';
  return '';
}

function simSide(action) {
  return recSide(action);
}

function listRecDates(advisor) {
  return readdir(recsDir(advisor)).then((names) => (
    names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => basename(name, '.json')).sort().reverse()
  )).catch(() => []);
}

function intentsFromRec(json, date) {
  const out = [];
  const seen = new Set();
  for (const book of json?.accounts || []) {
    for (const row of book.recommendations || []) {
      const symbol = String(row.symbol || '').toUpperCase();
      const action = String(row.action || '').toUpperCase();
      if (!symbol || !TRADE.has(action)) continue;
      const key = `${book.id}:${symbol}:${recSide(action)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        accountId: book.id,
        symbol,
        action,
        kind: row.kind || 'position',
        instrument: row.instrument || 'stock',
        title: row.title || '',
        source: 'recommendations'
      });
    }
  }
  for (const order of json?.orders || []) {
    const accountId = accountIdForOrder(order, json);
    const symbol = String(order.symbol || '').toUpperCase();
    const action = orderAction(order);
    if (!accountId || !symbol || !TRADE.has(action)) continue;
    const key = `${accountId}:${symbol}:${recSide(action)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      accountId,
      symbol,
      action,
      kind: 'order',
      instrument: order.instrument || 'stock',
      title: order.rationale || order.recommendation_id || '',
      source: 'orders'
    });
  }
  return out;
}

async function loadSimHistory(advisor) {
  const kind = advisor === 'chatgpt' ? 'sim-chatgpt' : 'sim-grok';
  const local = await readJson(join(SIM_DIR, `${kind}.json`));
  if (Array.isArray(local?.history)) return local.history;
  const vault = await readJson(join(simVaultDir(advisor), `${kind}.json`));
  return vault?.history || [];
}

function matchFill(fills, accountId, symbol, side) {
  return (fills || []).find((row) => (
    row.accountId === accountId
    && String(row.symbol || '').toUpperCase() === symbol
    && (side ? simSide(row.action || row.side) === side : true)
    && row.filled !== false
  )) || null;
}

export async function buildReviewDesk({ advisor = 'grok', limit = 16 } = {}) {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const dates = (await listRecDates(who)).slice(0, Math.max(4, Number(limit) || 16));
  const actualDays = await loadActualFiles(who);
  const actualByDate = new Map(actualDays.map((row) => [row.date, row.entries || []]));
  const simHistory = await loadSimHistory(who);
  const simByDate = new Map((simHistory || []).map((row) => [row.date, row]));

  const days = [];
  const totals = {
    asked: 0,
    simFollowed: 0,
    actualFollowed: 0,
    both: 0,
    simOnly: 0,
    actualMiss: 0,
    extraActuals: 0
  };

  for (const date of dates) {
    const rec = await readJson(join(recsDir(who), `${date}.json`));
    const intents = intentsFromRec(rec, date);
    const simDay = simByDate.get(date);
    const simFills = simDay?.fills || [];
    const actuals = actualByDate.get(date) || [];
    const rows = [];
    const usedActual = new Set();

    for (const intent of intents) {
      const side = recSide(intent.action);
      const sim = matchFill(simFills, intent.accountId, intent.symbol, side);
      const actual = (actuals || []).find((row) => (
        row.accountId === intent.accountId
        && String(row.symbol || '').toUpperCase() === intent.symbol
        && actualSide(row.side) === side
      )) || null;
      if (actual) usedActual.add(actual.id || actual.orderId || `${actual.symbol}:${actual.side}:${actual.qty}`);
      let follow = 'miss';
      if (sim && actual) follow = 'both';
      else if (sim) follow = 'sim-only';
      else if (actual) follow = 'actual-only';
      rows.push({
        ...intent,
        sim: sim ? { action: sim.action, qty: sim.qty, price: sim.price } : null,
        actual: actual ? { side: actual.side, qty: actual.qty, price: actual.price, orderId: actual.orderId || null } : null,
        follow
      });
      totals.asked += 1;
      if (sim) totals.simFollowed += 1;
      if (actual) totals.actualFollowed += 1;
      if (follow === 'both') totals.both += 1;
      else if (follow === 'sim-only') totals.simOnly += 1;
      else if (follow === 'miss') totals.actualMiss += 1;
    }

    const extras = (actuals || []).filter((row) => {
      const key = row.id || row.orderId || `${row.symbol}:${row.side}:${row.qty}`;
      if (usedActual.has(key)) return false;
      return ACCOUNT_IDS.includes(row.accountId);
    }).map((row) => ({
      date,
      accountId: row.accountId,
      symbol: String(row.symbol || '').toUpperCase(),
      action: row.side,
      qty: row.qty,
      price: row.price,
      follow: 'extra-actual',
      note: '实际有成交，当日推荐没有对应买卖。'
    }));
    totals.extraActuals += extras.length;

    days.push({
      date,
      recFound: Boolean(rec),
      asked: intents.length,
      simFills: simFills.filter((row) => row.filled !== false).length,
      actualFills: actuals.length,
      both: rows.filter((row) => row.follow === 'both').length,
      simOnly: rows.filter((row) => row.follow === 'sim-only').length,
      miss: rows.filter((row) => row.follow === 'miss').length,
      rows,
      extras
    });
  }

  const asked = totals.asked || 0;
  return {
    ok: true,
    liveTrading: false,
    date: todayStamp(),
    advisor: who,
    note: '先看有没有执行，不看赚没赚。HOLD / WATCH / REVIEW / 期权推荐不算要成交。不写进三本账。',
    totals: {
      ...totals,
      simRate: asked ? Number((totals.simFollowed / asked * 100).toFixed(1)) : null,
      actualRate: asked ? Number((totals.actualFollowed / asked * 100).toFixed(1)) : null
    },
    days
  };
}
