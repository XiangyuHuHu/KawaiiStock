import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { loadHistoricals } from '../historicals.js';
import { buildDecisionCards } from './decision-card.js';
import { sectorEtfFor } from './relative-strength.js';
import {
  applyQuantPaperTick,
  loadOwnerSnapshot,
  quantPaperPath,
  seedOwnerPaperBook
} from './paper-book.js';

const FLAGS = {
  observationOnly: true,
  paperOnly: true,
  liveTrading: false,
  liveTradingAuthority: false,
  placesOrders: false,
  autoTrade7811: false,
  brokerOrders: false,
  researchDefaults: true
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
  return value;
}

export async function cardsFromMarket(symbols = []) {
  const list = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return { ok: false, error: 'missing-symbol', ...FLAGS, cards: [] };
  const sectorSymbols = [...new Set(list.map((symbol) => sectorEtfFor(symbol)).filter(Boolean))];
  const wanted = [...new Set([...list, 'SPY', 'QQQ', ...sectorSymbols])];
  const loaded = {};
  await Promise.all(wanted.map(async (symbol) => {
    try {
      loaded[symbol] = await loadHistoricals(symbol);
    } catch (error) {
      loaded[symbol] = { ok: false, bars: [], error: error.message };
    }
  }));
  const spyBars = loaded.SPY?.bars || [];
  const qqqBars = loaded.QQQ?.bars || [];
  const cards = list.map((symbol) => {
    const pack = loaded[symbol] || { ok: false, bars: [] };
    const sector = sectorEtfFor(symbol);
    const card = buildDecisionCards({
      symbols: [symbol],
      barsBySymbol: { [symbol]: pack.bars || [] },
      spyBars,
      qqqBars,
      sectorBarsBySymbol: sector ? { [symbol]: loaded[sector]?.bars || [] } : {},
      sectorSymbol: sector
    }).cards[0];
    return { ...card, marketOk: pack.ok !== false, marketError: pack.error || null };
  });
  return { ok: true, ...FLAGS, cards };
}

export async function readQuantPaper() {
  const saved = await readJson(quantPaperPath());
  if (!saved) return { ok: true, empty: true, ...FLAGS, fills: [], positions: [] };
  return { ...saved, ...FLAGS };
}

export async function seedQuantPaperFile() {
  const book = seedOwnerPaperBook(await loadOwnerSnapshot());
  await writeJson(quantPaperPath(), book);
  return book;
}

export async function tickQuantPaperFile(input = {}) {
  const current = await readJson(quantPaperPath());
  const book = current || seedOwnerPaperBook(await loadOwnerSnapshot());
  let barsBySymbol = input.barsBySymbol || {};
  let spyBars = input.spyBars || [];
  let qqqBars = input.qqqBars || [];
  if (input.loadMarket === true) {
    const symbols = [...new Set([
      ...book.positions.map((row) => row.symbol),
      ...Object.keys(book.exits || {})
    ])];
    const fetched = {};
    await Promise.all(['SPY', 'QQQ', ...symbols].map(async (symbol) => {
      try {
        fetched[symbol] = (await loadHistoricals(symbol)).bars || [];
      } catch {
        fetched[symbol] = [];
      }
    }));
    barsBySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, fetched[symbol] || []]));
    spyBars = fetched.SPY || [];
    qqqBars = fetched.QQQ || [];
  }
  const next = applyQuantPaperTick(book, { ...input, barsBySymbol, spyBars, qqqBars });
  await writeJson(quantPaperPath(), next);
  return next;
}
