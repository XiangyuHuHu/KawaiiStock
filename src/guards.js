import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lastSessionStamp, recsDir, todayStamp } from './paths.js';
import { loadAccounts, loadHoldings } from './holdings.js';
import { loadQuotes } from './quotes.js';

const SCAN_IDS = ['tactical', 'agentic'];
const CLOSED = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'expired', 'failed', 'replaced']);
const SELL = new Set(['sell', 'sell_short', 'trim', 'exit', 'close']);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPlaceholder(symbol) {
  const sym = String(symbol || '').toUpperCase();
  return !sym || sym === '—' || /ZZZ$/.test(sym);
}

function orderStatus(row) {
  return String(row?.status || row?.state || '').toLowerCase();
}

function isWorking(row) {
  const status = orderStatus(row);
  if (!status) return true;
  return !CLOSED.has(status);
}

function orderType(row) {
  return String(row?.type || row?.orderType || row?.order_type || row?.trigger || '').toLowerCase();
}

function isStopOrder(row) {
  const type = orderType(row);
  if (type.includes('stop')) return true;
  if (row?.stopPrice != null || row?.stop_price != null || row?.stop != null) return true;
  return false;
}

function orderSide(row) {
  return String(row?.side || row?.direction || '').toLowerCase();
}

function stopPriceOf(row) {
  const direct = num(row?.stopPrice ?? row?.stop_price ?? row?.stop ?? row?.trigger_price);
  if (direct != null) return direct;
  if (isStopOrder(row)) return num(row?.price);
  return null;
}

function orderQty(row) {
  return num(row?.qty ?? row?.quantity ?? row?.remaining_quantity) || 0;
}

function orderPrice(row) {
  return num(row?.price ?? row?.limit_price ?? row?.limitPrice) ?? stopPriceOf(row);
}

async function loadLatestRecs(advisor = 'grok') {
  const dir = recsDir(advisor);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return { date: null, byKey: {} };
  }
  const dates = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
  const date = dates[0] || null;
  if (!date) return { date: null, byKey: {} };
  const json = await readJson(join(dir, `${date}.json`));
  const byKey = {};
  for (const book of json?.accounts || []) {
    for (const row of book.recommendations || []) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (!symbol) continue;
      byKey[`${book.id}:${symbol}`] = row;
    }
  }
  return { date, byKey, json };
}

function classify({ account, pos, last, failPrice, stops, working }) {
  const qty = num(pos.qty) || 0;
  const covered = stops.reduce((sum, row) => sum + orderQty(row), 0);
  const nearest = stops
    .map((row) => stopPriceOf(row))
    .filter((n) => n != null)
    .sort((a, b) => b - a)[0] ?? null;
  const noInterface = account.source === 'manual' || account.id === 'main';
  let status = 'ok';
  let severity = 0;
  let note = '';

  if (qty <= 0 || isPlaceholder(pos.symbol)) {
    return { status: 'skip', severity: 0, note: '占位或不计仓。', covered, nearest };
  }
  if (last != null && nearest != null && last <= nearest) {
    status = 'hit-stop';
    severity = 5;
    note = `现价已到/跌破券商止损 ${nearest}。扫描若仍显示未成交，先核对券商。`;
  } else if (last != null && failPrice != null && last <= failPrice) {
    status = 'hit-fail';
    severity = 4;
    note = `现价已到推荐失效价 ${failPrice}。止损必须及时。`;
  } else if (!noInterface && !stops.length) {
    status = 'missing';
    severity = 3;
    note = '没有券商侧止损卖单。开仓必须带止损。';
  } else if (!noInterface && covered + 1e-6 < qty) {
    status = 'partial';
    severity = 2;
    note = `止损数量 ${covered} < 持仓 ${qty}。`;
  } else if (!noInterface && nearest != null && failPrice != null && nearest < failPrice * 0.97) {
    status = 'loose';
    severity = 1;
    note = `券商止损 ${nearest} 比失效价 ${failPrice} 更松。`;
  } else if (noInterface) {
    status = failPrice == null ? 'manual' : 'manual-ok';
    severity = 0;
    note = failPrice == null
      ? '主账户无 Robinhood 接口。失效价看推荐，止损不能从券商扫描。'
      : `主账户无接口。推荐失效价 ${failPrice}。`;
  } else {
    status = 'covered';
    severity = 0;
    note = nearest != null ? `止损已挂 ${nearest}。` : '有未完成卖单。';
  }

  const extra = working.filter((row) => !isStopOrder(row) || !SELL.has(orderSide(row)));
  if (extra.length && status === 'covered') {
    note += ` 另有 ${extra.length} 笔未完成挂单。`;
  }
  return { status, severity, note, covered, nearest };
}

export async function buildGuardsDesk() {
  const config = await loadAccounts('grok');
  const recs = await loadLatestRecs('grok');
  const books = [];
  for (const account of config.accounts || []) {
    books.push({ account, holdings: await loadHoldings(account) });
  }

  const symbols = [...new Set(books.flatMap(({ holdings }) => [
    ...(holdings.positions || []).map((row) => row.symbol),
    ...(holdings.openOrders || []).map((row) => row.symbol)
  ].filter((sym) => !isPlaceholder(sym))))];
  const quotes = await loadQuotes(symbols);

  const positions = [];
  const openOrders = [];
  const orphans = [];

  for (const { account, holdings } of books) {
    const working = (holdings.openOrders || []).filter(isWorking);
    for (const row of working) {
      const symbol = String(row.symbol || '').toUpperCase();
      const item = {
        accountId: account.id,
        accountLabel: account.short || account.label,
        symbol,
        side: orderSide(row) || '—',
        type: orderType(row) || '—',
        qty: orderQty(row),
        price: orderPrice(row),
        stopPrice: stopPriceOf(row),
        status: orderStatus(row) || 'open',
        orderId: row.orderId || row.id || '',
        isStop: isStopOrder(row) && SELL.has(orderSide(row))
      };
      openOrders.push(item);
    }

    const held = new Set((holdings.positions || []).map((row) => String(row.symbol || '').toUpperCase()));
    for (const row of working) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (symbol && !held.has(symbol) && !isPlaceholder(symbol)) {
        orphans.push({
          accountId: account.id,
          accountLabel: account.short || account.label,
          symbol,
          side: orderSide(row) || '—',
          type: orderType(row) || '—',
          qty: orderQty(row),
          price: orderPrice(row),
          stopPrice: stopPriceOf(row),
          status: orderStatus(row) || 'open',
          orderId: row.orderId || row.id || '',
          note: '当前持仓里没有这只。未成交止损/挂单，不是成交。'
        });
      }
    }

    for (const pos of holdings.positions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      const quote = quotes[symbol];
      const last = quote?.ok && quote.last != null ? quote.last : (num(pos.last) ?? null);
      const rec = recs.byKey[`${account.id}:${symbol}`] || {};
      const failPrice = num(rec.failPrice ?? rec.strategy?.stop);
      const stops = working.filter((row) => (
        String(row.symbol || '').toUpperCase() === symbol
        && isStopOrder(row)
        && SELL.has(orderSide(row))
      ));
      const related = working.filter((row) => String(row.symbol || '').toUpperCase() === symbol);
      const verdict = classify({ account, pos, last, failPrice, stops, working: related });
      const distStop = last != null && verdict.nearest != null && last !== 0
        ? Number((((last - verdict.nearest) / last) * 100).toFixed(1))
        : null;
      positions.push({
        accountId: account.id,
        accountLabel: account.short || account.label,
        scannable: SCAN_IDS.includes(account.id),
        symbol,
        name: pos.name || symbol,
        qty: num(pos.qty),
        avgCost: num(pos.avgCost),
        last,
        failPrice,
        recAction: rec.action || null,
        stopPrice: verdict.nearest,
        stopQty: verdict.covered,
        status: verdict.status,
        severity: verdict.severity,
        note: verdict.note,
        distStopPct: distStop,
        stale: Boolean(holdings.stale),
        asOf: holdings.asOf || null
      });
    }

    for (const pos of holdings.optionPositions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!symbol) continue;
      positions.push({
        accountId: account.id,
        accountLabel: account.short || account.label,
        scannable: SCAN_IDS.includes(account.id),
        symbol,
        name: `${pos.side || ''} ${pos.type || 'option'} ${pos.expiration || ''} ${pos.strike ?? ''}`.trim(),
        qty: num(pos.qty),
        avgCost: null,
        last: num(pos.markPricePerShare ?? pos.last),
        failPrice: null,
        recAction: null,
        stopPrice: null,
        stopQty: 0,
        status: 'option',
        severity: 1,
        note: `期权。最大亏损看剩余权利金。到期 ${pos.expiration || '—'}。不要用股票止损规则硬套。`,
        distStopPct: null,
        stale: Boolean(holdings.stale),
        asOf: holdings.asOf || null,
        instrument: 'option',
        expiration: pos.expiration || null
      });
    }
  }

  positions.sort((a, b) => b.severity - a.severity || String(a.accountId).localeCompare(b.accountId) || String(a.symbol).localeCompare(b.symbol));
  const alerts = positions.filter((row) => row.severity >= 2);
  const missingStops = positions.filter((row) => row.status === 'missing' || row.status === 'partial');

  return {
    ok: true,
    liveTrading: false,
    draft: true,
    date: todayStamp(),
    session: lastSessionStamp(),
    recDate: recs.date,
    note: '只看券商未完成订单和推荐失效价。未成交止损不是成交。不是下单指令。不写进推荐/模拟/实际操作。',
    counts: {
      positions: positions.length,
      alerts: alerts.length,
      missingStops: missingStops.length,
      openOrders: openOrders.length,
      orphans: orphans.length
    },
    positions,
    openOrders,
    orphans,
    quotes
  };
}
