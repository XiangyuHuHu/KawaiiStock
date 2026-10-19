import { sessionClosed } from '../market-time.js';
import { loadUniverse } from '../universe.js';
import { loadManyHistoricals } from '../historicals.js';
import { loadMarketCaps } from '../quotes.js';
import { fetchChinaQuotes } from '../screener/cn-market-data.mjs';
import { loadChinaOracleHistory } from '../oracle/cn-data.js';
import { loadXiaomengCnUniverse, loadXiaomengUsFallback } from './xiaomeng-universe.js';
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

const cnHistoryCache = new Map();
const CN_HISTORY_TTL = 15 * 60 * 1000;

async function cachedCnHistory(symbol) {
  const hit = cnHistoryCache.get(symbol);
  if (hit && Date.now() - hit.at < CN_HISTORY_TTL) return hit.value;
  let value;
  try {
    value = await loadChinaOracleHistory(symbol);
  } catch (error) {
    value = { ok: false, bars: [], error: error.message };
  }
  cnHistoryCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function loadCnBook(now) {
  const universe = await loadXiaomengCnUniverse({ now });
  const symbols = universe.symbols;
  const packs = await pool(symbols, 4, (symbol) => cachedCnHistory(symbol));
  const barsBySymbol = {};
  symbols.forEach((symbol, index) => {
    const bars = closedForMarket(shareBars(packs[index], 'cn'), 'cn', now);
    if (bars.length) barsBySymbol[symbol] = bars;
  });
  return {
    market: 'cn',
    barsBySymbol,
    lists: universe.listOf,
    members: universe.members,
    companies: universe.companies,
    seedCaps: universe.seedCaps,
    universe: universe.universe,
    lot: 100
  };
}

async function loadUsBook(now) {
  const loaded = await loadUniverse();
  const thin = Boolean(loaded.fallback) || (loaded.symbols || []).length < 8;
  let listOf = {};
  let members = {};
  let universeNote = { file: 'vault', symbols: (loaded.symbols || []).length, fallback: false };
  if (thin) {
    const fallback = await loadXiaomengUsFallback();
    listOf = fallback.listOf;
    members = fallback.members;
    universeNote = fallback.universe;
  } else {
    for (const row of loaded.symbols || []) {
      listOf[row.symbol] = row.lists || [];
      for (const title of row.lists || []) {
        if (!members[title]) members[title] = [];
        members[title].push(row.symbol);
      }
    }
  }
  const symbols = Object.keys(listOf);
  const history = await loadManyHistoricals(symbols, { concurrency: 4 });
  const barsBySymbol = {};
  for (const symbol of symbols) {
    const bars = closedForMarket(history[symbol]?.bars, 'us', now);
    if (bars.length) barsBySymbol[symbol] = bars;
  }
  return { market: 'us', barsBySymbol, lists: listOf, members, companies: {}, seedCaps: {}, universe: universeNote, lot: 1 };
}

async function capsFor(market, symbols) {
  const caps = {};
  if (!symbols.length) return caps;
  if (market === 'cn') {
    const quotes = await fetchChinaQuotes(symbols.map((symbol) => ({ symbol })));
    for (const symbol of symbols) caps[symbol] = quotes.get(symbol)?.floatMarketCap ?? null;
    return caps;
  }
  // Nasdaq summary 只有总市值。Yahoo chart 的 meta.marketCap 已经空了，不能再当过滤依据。
  return loadMarketCaps(symbols);
}

export async function prepareXiaomeng(desk, now = new Date()) {
  const book = desk === '0g' ? await loadCnBook(now) : await loadUsBook(now);
  const rough = [];
  for (const [symbol, bars] of Object.entries(book.barsBySymbol)) {
    const setup = entrySetup(bars, { symbol, market: book.market, company: book.companies[symbol] });
    if (setup.ok) rough.push(symbol);
  }
  const caps = await capsFor(book.market, rough);
  for (const [symbol, cap] of Object.entries(book.seedCaps || {})) {
    if (!(caps[symbol] > 0) && cap > 0) caps[symbol] = cap;
  }
  const picked = selectXiaomeng({
    market: book.market,
    barsBySymbol: book.barsBySymbol,
    lists: book.lists,
    members: book.members,
    caps,
    companies: book.companies
  });
  return { ...book, ...picked, caps, rulesId: picked.rules };
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

export { LIMIT_PULLBACK, floatOk, sectorResonance, sizeLimitPullback };
