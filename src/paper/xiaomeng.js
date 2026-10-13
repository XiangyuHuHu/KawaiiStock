import { chinaStamp } from '../paths.js';
import { sessionClosed } from '../market-time.js';
import { loadUniverse } from '../universe.js';
import { loadManyHistoricals } from '../historicals.js';
import { loadQuotes } from '../quotes.js';
import { fetchChinaQuotes, loadChinaWatchlists } from '../screener/cn-market-data.mjs';
import { loadChinaOracleHistory } from '../oracle/cn-data.js';
import { paperEquityNeedsReference } from './execution.js';
import {
  LIMIT_PULLBACK,
  chinaSessionClosed,
  entrySetup,
  exitSetup,
  floatOk,
  sectorResonance,
  selectXiaomeng,
  sizeLimitPullback
} from './limit-pullback.js';

export { selectXiaomeng };

function chinaSessionClosedSafe(day, now) {
  return chinaSessionClosed(day, now);
}

export function closedForMarket(bars, market, now = new Date()) {
  const gate = market === 'cn' ? (day) => chinaSessionClosedSafe(day, now) : (day) => sessionClosed(day, now);
  return (bars || []).filter((bar) => bar?.date && gate(bar.date));
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
  return out;
}

function shareBars(pack, market) {
  const bars = pack?.bars || [];
  if (market !== 'cn') return bars;
  return bars.map((bar) => ({ ...bar, volume: (Number(bar.volume) || 0) * 100 }));
}

async function loadCnBook(now) {
  const lists = await loadChinaWatchlists();
  const bySymbol = new Map();
  const members = {};
  const listOf = {};
  const companies = {};
  for (const list of lists) {
    members[list.title] = [];
    for (const row of list.stocks || []) {
      const symbol = String(row.symbol || '');
      if (!/^\d{6}$/.test(symbol)) continue;
      companies[symbol] = row.company || companies[symbol] || '';
      if (!listOf[symbol]) listOf[symbol] = [];
      if (!listOf[symbol].includes(list.title)) listOf[symbol].push(list.title);
      if (!members[list.title].includes(symbol)) members[list.title].push(symbol);
      bySymbol.set(symbol, true);
    }
  }
  const symbols = [...bySymbol.keys()];
  const packs = await pool(symbols, 4, async (symbol) => {
    try {
      return await loadChinaOracleHistory(symbol);
    } catch (error) {
      return { ok: false, bars: [], error: error.message };
    }
  });
  const barsBySymbol = {};
  symbols.forEach((symbol, index) => {
    const bars = closedForMarket(shareBars(packs[index], 'cn'), 'cn', now);
    if (bars.length) barsBySymbol[symbol] = bars;
  });
  return { market: 'cn', barsBySymbol, lists: listOf, members, companies, lot: 100 };
}

async function loadUsBook(now) {
  const universe = await loadUniverse();
  const listOf = {};
  const members = {};
  for (const row of universe.symbols || []) {
    listOf[row.symbol] = row.lists || [];
    for (const title of row.lists || []) {
      if (!members[title]) members[title] = [];
      members[title].push(row.symbol);
    }
  }
  const symbols = Object.keys(listOf);
  const history = await loadManyHistoricals(symbols, { concurrency: 4 });
  const barsBySymbol = {};
  for (const symbol of symbols) {
    const bars = closedForMarket(history[symbol]?.bars, 'us', now);
    if (bars.length) barsBySymbol[symbol] = bars;
  }
  return { market: 'us', barsBySymbol, lists: listOf, members, companies: {}, lot: 1 };
}

async function yahooCap(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const cap = (await response.json())?.chart?.result?.[0]?.meta?.marketCap;
  return Number(cap) > 0 ? Number(cap) : null;
}

async function capsFor(market, symbols) {
  const caps = {};
  if (!symbols.length) return caps;
  if (market === 'cn') {
    const quotes = await fetchChinaQuotes(symbols.map((symbol) => ({ symbol })));
    for (const symbol of symbols) caps[symbol] = quotes.get(symbol)?.floatMarketCap ?? null;
    return caps;
  }
  const values = await pool(symbols, 4, (symbol) => yahooCap(symbol).catch(() => null));
  symbols.forEach((symbol, index) => { caps[symbol] = values[index]; });
  return caps;
}

export async function prepareXiaomeng(desk, now = new Date()) {
  const book = desk === '0g' ? await loadCnBook(now) : await loadUsBook(now);
  const rough = [];
  for (const [symbol, bars] of Object.entries(book.barsBySymbol)) {
    const setup = entrySetup(bars, { symbol, market: book.market, company: book.companies[symbol] });
    if (setup.ok) rough.push(symbol);
  }
  const caps = await capsFor(book.market, rough);
  const picked = selectXiaomeng({
    market: book.market,
    barsBySymbol: book.barsBySymbol,
    lists: book.lists,
    members: book.members,
    caps,
    companies: book.companies
  });
  return { ...book, ...picked, caps };
}

export function xiaomengExits(ledger, barsBySymbol, { market, lot }) {
  return (ledger.positions || []).map((pos) => {
    const bars = barsBySymbol[pos.symbol] || [];
    const entryDate = (ledger.fills || [])
      .filter((row) => row.symbol === pos.symbol && row.side === 'buy')
      .map((row) => String(row.date || '').slice(0, 10))
      .sort()[0] || null;
    const halfTake = (ledger.fills || []).some((row) => row.symbol === pos.symbol && String(row.note || '').includes('take5'));
    const halfStop = (ledger.fills || []).some((row) => row.symbol === pos.symbol && String(row.note || '').includes('stop4'));
    const plan = exitSetup(
      { ...pos, entryDate, symbol: pos.symbol },
      bars,
      { market, lot, halfTake, halfStop }
    );
    return { symbol: pos.symbol, ...plan, price: bars.at(-1)?.close || null };
  });
}

export function xiaomengQuote(market, row) {
  if (market === 'cn') {
    return {
      ok: row.price > 0,
      last: row.price,
      quoteAt: row.marketDate || null,
      company: row.company || ''
    };
  }
  return row;
}

export { LIMIT_PULLBACK, floatOk, sectorResonance, sizeLimitPullback, chinaStamp };
