import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atrValue } from '../levels.js';
import { DATA_DIR, ROOT } from '../paths.js';
import { bookCash, isCashRow, volClassOf } from '../bot/main-trailing.js';
import { buildDecisionCard } from './decision-card.js';

export const QUANT_PAPER_ID = 'owner-7811-paper';
export const OWNER_SNAPSHOT = join(ROOT, 'test/fixtures/positions-2026-10-15.json');

const FLAGS = {
  id: QUANT_PAPER_ID,
  label: '主人真实持仓纸上账本 · Self-Directed ••••7811',
  book: '7811',
  ownerBot: 'Kawaii小胡',
  operableByKawaiiMeigu: false,
  observationOnly: true,
  paperOnly: true,
  liveTrading: false,
  liveTradingAuthority: false,
  placesOrders: false,
  autoTrade7811: false,
  brokerOrders: false,
  researchDefaults: true,
  pendingBacktest: true,
  driver: 'kawaii-quant-v1',
  orderQty: null
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  const n = num(value);
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function seal(book) {
  return { ...book, ...FLAGS, orderQty: null };
}

export async function loadOwnerSnapshot() {
  return JSON.parse(await readFile(OWNER_SNAPSHOT, 'utf8'));
}

export function seedOwnerPaperBook(snapshot = {}, options = {}) {
  const cash = bookCash(snapshot);
  const rows = (snapshot.positions || snapshot.holdings || []).filter((row) => !isCashRow(row) && num(row.qty ?? row.quantity) > 0);
  const positions = rows.map((row) => {
    const qty = num(row.qty ?? row.quantity);
    const avgCost = num(row.avgCost ?? row.averageCost ?? row.entry);
    return {
      symbol: String(row.symbol || '').trim().toUpperCase(),
      qty,
      avgCost,
      last: avgCost,
      costTotal: num(row.costTotal) ?? (qty != null && avgCost != null ? round(qty * avgCost, 2) : null),
      theme: row.theme || null,
      volClass: volClassOf(row),
      invalidation: num(row.invalidation),
      invalidationSource: row.invalidation != null ? 'input' : null,
      atr14: num(row.atr14),
      peakClose: avgCost,
      stop: num(row.stop ?? row.stopPrice),
      trimmed2R: false,
      trimmed3R: false,
      peakUnrealizedUsd: 0
    };
  }).filter((row) => row.symbol);
  const equity = positions.reduce((total, row) => total + (row.costTotal || 0), 0);
  const day0Capital = round((cash.cashUsd || 0) + equity, 2);
  const book = seal({
    ok: true,
    source: 'positions-2026-10-15',
    sourceNote: 'Day0 用 Self-Directed ••••7811 截图。JPMPD 记成现金。截图没有现价，标记先等于成本。纸上成交不是券商单。',
    asOf: options.asOf || snapshot.asOf || null,
    day0: options.asOf || snapshot.asOf || null,
    cash: cash.cashUsd,
    cashSymbols: cash.cashSymbols,
    equityCostBasisUsd: num(snapshot.equityCostBasisUsd) ?? round(equity, 2),
    day0Capital,
    day0Cash: cash.cashUsd,
    day0Positions: positions.map((row) => ({ symbol: row.symbol, qty: row.qty, avgCost: row.avgCost })),
    nav: day0Capital,
    peakNav: day0Capital,
    pnl: 0,
    peakPnl: 0,
    givebackPct: 0,
    buyHoldNav: day0Capital,
    buyHoldPnl: 0,
    realizedPnl: 0,
    positions,
    exits: {},
    fills: [],
    stopMoves: [],
    skips: [],
    lastDecisions: [],
    ticks: 0
  });
  return book;
}

function markPrice(symbol, { prices = {}, barsBySymbol = {} }, fallback) {
  const explicit = num(prices[symbol]);
  if (explicit != null) return explicit;
  const bars = barsBySymbol[symbol] || [];
  const close = bars.length ? num(bars[bars.length - 1].close) : null;
  return close ?? fallback;
}

function ensureInvalidation(position, bars) {
  if (position.invalidation != null) return position;
  const atr = position.atr14 || atrValue(bars || [], 14);
  if (!(atr > 0) || !(position.avgCost > 0)) return position;
  const k = position.volClass === 'event' || position.volClass === 'high-vol' ? 3 : 2.5;
  const invalidation = round(position.avgCost - k * atr, 4);
  if (!(invalidation > 0) || !(invalidation < position.avgCost)) return position;
  position.invalidation = invalidation;
  position.invalidationSource = 'research-atr';
  position.atr14 = position.atr14 || round(atr, 4);
  return position;
}

function pushFill(book, row) {
  book.fills.push({
    ...row,
    paper: true,
    broker: false,
    placesOrders: false,
    priceSource: 'research-close'
  });
}

function applyHeld(book, position, card, price, asOf) {
  const action = card.suggestedAction;
  if (card.trailingStop != null && action !== 'EXIT') {
    const next = position.stop == null ? card.trailingStop : Math.max(position.stop, card.trailingStop);
    if (position.stop == null || next > position.stop + 1e-9) {
      book.stopMoves.push({ at: asOf, symbol: position.symbol, from: position.stop, to: next, reason: card.tightenReason || 'atr-ratchet' });
      position.stop = next;
    }
  }
  if (action === 'TRIM') {
    const pct = Array.isArray(card.referenceTrimPct) ? card.referenceTrimPct[0] : null;
    const qty = pct > 0 && pct < 1 ? Math.floor(position.qty * pct) : 0;
    if (!(qty > 0) || qty >= position.qty) {
      book.skips.push({ at: asOf, symbol: position.symbol, action, reason: 'qty-below-tranche' });
      return;
    }
    const proceeds = round(qty * price, 2);
    position.qty -= qty;
    book.cash = round(book.cash + proceeds, 2);
    book.realizedPnl = round(book.realizedPnl + (price - position.avgCost) * qty, 2);
    if (card.reason === '2r-trim' || card.reason === '3r-combined' || card.reason === '3r-second-tranche') position.trimmed2R = true;
    if (card.reason === '3r-combined' || card.reason === '3r-second-tranche') position.trimmed3R = true;
    pushFill(book, {
      at: asOf,
      symbol: position.symbol,
      action: 'TRIM',
      trailingAction: card.trailingAction,
      qty,
      price,
      reason: card.reason,
      regime: card.regime,
      stage: card.stage,
      stop: position.stop,
      givebackPct: card.givebackPct
    });
    return;
  }
  if (action === 'EXIT') {
    const qty = position.qty;
    const proceeds = round(qty * price, 2);
    book.cash = round(book.cash + proceeds, 2);
    book.realizedPnl = round(book.realizedPnl + (price - position.avgCost) * qty, 2);
    pushFill(book, {
      at: asOf,
      symbol: position.symbol,
      action: 'EXIT',
      trailingAction: card.trailingAction,
      qty,
      price,
      reason: card.reason,
      regime: card.regime,
      stage: card.stage,
      stop: card.trailingStop,
      givebackPct: card.givebackPct
    });
    const prior = book.exits[position.symbol] || { soldQty: 0, planQty: position.qty + (book.exits[position.symbol]?.soldQty || 0), tranches: 0 };
    book.exits[position.symbol] = {
      symbol: position.symbol,
      sellReason: card.reason,
      soldQty: prior.soldQty + qty,
      planQty: prior.planQty || qty,
      tranches: prior.tranches || 0,
      lastExitPrice: price,
      at: asOf,
      theme: position.theme,
      volClass: position.volClass
    };
    position.qty = 0;
  }
}

function applyFlat(book, symbol, card, price, asOf, exit) {
  if (card.suggestedAction !== 'REBUY' || !card.reentry?.allowed) {
    if (card.reason === 'rebuy-down-20-alone' || card.reentry?.reason === 'rebuy-down-20-alone') {
      book.skips.push({ at: asOf, symbol, action: 'REBUY', reason: 'rebuy-down-20-alone' });
    }
    return;
  }
  const plan = exit?.planQty || exit?.soldQty || 0;
  const tranche = card.trailingAction === 'REBUY_ADD' ? 2 : 1;
  const qty = Math.floor(plan / 3);
  const cost = round(qty * price, 2);
  if (!(qty > 0) || !(cost > 0) || cost > book.cash + 1e-9) {
    book.skips.push({ at: asOf, symbol, action: 'REBUY', reason: 'cash-or-qty-short' });
    return;
  }
  book.cash = round(book.cash - cost, 2);
  book.positions.push({
    symbol,
    qty,
    avgCost: price,
    last: price,
    costTotal: cost,
    theme: exit.theme || null,
    volClass: exit.volClass || 'growth',
    invalidation: null,
    invalidationSource: null,
    atr14: null,
    peakClose: price,
    stop: card.trailingStop,
    trimmed2R: false,
    trimmed3R: false,
    peakUnrealizedUsd: 0
  });
  exit.tranches = tranche;
  pushFill(book, {
    at: asOf,
    symbol,
    action: 'REBUY',
    trailingAction: card.trailingAction,
    qty,
    price,
    reason: card.reason,
    regime: card.regime,
    stage: card.stage,
    setup: card.reentry.setup,
    stop: card.trailingStop,
    givebackPct: null
  });
}

function markBook(book, marks) {
  const nav = round(book.cash + book.positions.reduce((total, row) => total + row.qty * (marks[row.symbol] ?? row.last ?? row.avgCost), 0), 2);
  const buyHoldNav = round(book.day0Cash + book.day0Positions.reduce((total, row) => total + row.qty * (marks[row.symbol] ?? row.avgCost), 0), 2);
  const pnl = round(nav - book.day0Capital, 2);
  const peakNav = Math.max(book.peakNav ?? nav, nav);
  const peakPnl = Math.max(book.peakPnl ?? pnl, pnl);
  book.nav = nav;
  book.peakNav = round(peakNav, 2);
  book.pnl = pnl;
  book.peakPnl = round(peakPnl, 2);
  book.givebackPct = peakPnl > 0 ? round((peakPnl - pnl) / peakPnl * 100, 4) : 0;
  book.buyHoldNav = buyHoldNav;
  book.buyHoldPnl = round(buyHoldNav - book.day0Capital, 2);
  for (const row of book.positions) {
    const mark = marks[row.symbol] ?? row.last;
    const unrealized = (mark - row.avgCost) * row.qty;
    row.peakUnrealizedUsd = Math.max(row.peakUnrealizedUsd || 0, unrealized);
  }
}

export function applyQuantPaperTick(book, input = {}) {
  const next = structuredClone(book);
  const asOf = input.asOf || null;
  const marks = {};
  const decisions = [];
  for (const position of next.positions) {
    const price = markPrice(position.symbol, input, position.last);
    if (price != null) {
      position.last = price;
      position.peakClose = Math.max(position.peakClose || price, price);
      marks[position.symbol] = price;
    }
    const bars = input.barsBySymbol?.[position.symbol] || [];
    ensureInvalidation(position, bars);
    const exit = next.exits[position.symbol];
    const card = buildDecisionCard({
      symbol: position.symbol,
      bars,
      spyBars: input.spyBars,
      qqqBars: input.qqqBars,
      sectorBars: input.sectorBarsBySymbol?.[position.symbol],
      asOf,
      position,
      dropFromExitPct: exit?.lastExitPrice > 0 && price != null ? (price / exit.lastExitPrice - 1) * 100 : null
    });
    decisions.push({ symbol: position.symbol, regime: card.regime, stage: card.stage, suggestedAction: card.suggestedAction, reason: card.reason, reasons: card.reasons });
    if (price != null && position.qty > 0) applyHeld(next, position, card, price, asOf);
  }
  next.positions = next.positions.filter((row) => row.qty > 0);
  for (const [symbol, exit] of Object.entries(next.exits || {})) {
    if (next.positions.some((row) => row.symbol === symbol)) continue;
    const price = markPrice(symbol, input, exit.lastExitPrice);
    if (price == null) continue;
    marks[symbol] = price;
    const card = buildDecisionCard({
      symbol,
      bars: input.barsBySymbol?.[symbol] || [],
      spyBars: input.spyBars,
      qqqBars: input.qqqBars,
      sectorBars: input.sectorBarsBySymbol?.[symbol],
      asOf,
      position: { symbol, qty: 0, theme: exit.theme, volClass: exit.volClass, rebuyAdd: (exit.tranches || 0) >= 1 },
      dropFromExitPct: exit.lastExitPrice > 0 ? (price / exit.lastExitPrice - 1) * 100 : null
    });
    decisions.push({ symbol, regime: card.regime, stage: card.stage, suggestedAction: card.suggestedAction, reason: card.reason, reasons: card.reasons });
    applyFlat(next, symbol, card, price, asOf, exit);
  }
  for (const row of next.day0Positions) {
    if (marks[row.symbol] == null) marks[row.symbol] = row.avgCost;
  }
  markBook(next, marks);
  next.lastDecisions = decisions;
  next.asOf = asOf || next.asOf;
  next.ticks = (next.ticks || 0) + 1;
  return seal(next);
}

export function quantPaperFromHeartbeat(input = {}) {
  try {
    const book = input.quantPaperBook
      || (input.quantPaperSnapshot ? seedOwnerPaperBook(input.quantPaperSnapshot) : null);
    if (!book) {
      return { skipped: true, reason: 'missing-paper-book', ...FLAGS };
    }
    const tick = input.quantPaper && typeof input.quantPaper === 'object' ? input.quantPaper : {};
    return applyQuantPaperTick(book, tick);
  } catch (error) {
    return { ok: false, error: error.message, ...FLAGS };
  }
}

export function quantPaperPath() {
  return join(DATA_DIR, 'quant', 'owner-7811-paper.json');
}
