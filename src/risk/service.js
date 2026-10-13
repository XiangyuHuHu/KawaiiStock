import { randomUUID } from 'node:crypto';
import { accountById, holdingsFreshness, holdingsNav, loadAccounts, loadHoldings } from '../holdings.js';
import { todayStamp } from '../paths.js';
import { assertOrder } from './gateway.js';
import { bookKeyOf, loadLimits, paperDeskOf, resolveCaps } from './limits.js';
import { resolveMode } from './mode.js';
import { realizedAgenticFromActuals } from './pnl.js';
import { bookState, loadRiskState, rememberOrder, saveRiskState, setKill, setMode, touchBook } from './state.js';

function bookPositions(holdings) {
  const stocks = (holdings.positions || []).map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    qty: Number(row.qty) || 0,
    last: row.last ?? null,
    avgCost: row.avgCost ?? null,
    marketValue: row.marketValue ?? null,
    theme: row.theme || '',
    instrument: 'equity',
    stopPrice: row.stopPrice ?? null,
    maxLoss: row.maxLoss ?? null
  }));
  const options = (holdings.optionPositions || []).map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    qty: Number(row.qty) || 0,
    last: row.markPricePerShare ?? row.last ?? null,
    marketValue: row.estimatedValue ?? null,
    expiration: row.expiration || null,
    strike: row.strike ?? null,
    instrument: 'option',
    stopPrice: row.stopPrice ?? null,
    maxLoss: row.maxLoss ?? row.estimatedValue ?? null
  }));
  return [...stocks, ...options];
}

export async function liveBookSnapshot() {
  const config = await loadAccounts('grok');
  const account = accountById(config, 'agentic');
  const holdings = account ? await loadHoldings(account) : { configured: false, missing: true };
  const freshness = holdingsFreshness(holdings);
  const nav = holdingsNav(holdings);
  const realized = await realizedAgenticFromActuals();
  const state = await loadRiskState();
  const slice = bookState(state, 'live');
  const peak = Math.max(Number(slice.peakNav) || 0, Number(nav) || 0) || null;
  const patch = {};
  if (peak && peak !== slice.peakNav) patch.peakNav = peak;
  if (slice.pnlDay !== realized.pnlDay || slice.pnlWeek !== realized.pnlWeek) {
    patch.pnlDay = realized.pnlDay;
    patch.pnlWeek = realized.pnlWeek;
    patch.actualsSyncAt = new Date().toISOString();
  }
  if (Object.keys(patch).length) await touchBook(state, 'live', patch);
  return {
    book: 'live',
    accountId: 'agentic',
    nav,
    cash: holdings.cash ?? null,
    buyingPower: holdings.buyingPower ?? holdings.cash ?? null,
    peakNav: peak,
    positions: bookPositions(holdings),
    openOrders: holdings.openOrders || [],
    realizedPnlToday: realized.pnlDay,
    realizedPnlWeek: realized.pnlWeek,
    realizedNote: realized.note,
    mode: slice.mode,
    modeReason: slice.reason,
    kill: slice.mode === 'KILL',
    killReason: slice.reason,
    holdingsConfigured: freshness.configured !== false,
    holdingsFresh: freshness.configured === false ? null : freshness.fresh,
    asOf: holdings.asOf || null,
    stale: freshness.stale
  };
}

async function snapshotFor(book, state) {
  if (String(book).startsWith('paper') || ['0a', '0b', '0c', '0d', '0e', '0f', '0g', '0h'].includes(book)) {
    const { paperBookSnapshot } = await import('../paper/desk.js');
    return paperBookSnapshot(state, paperDeskOf(book));
  }
  return liveBookSnapshot();
}

export async function checkOrder(raw = {}) {
  const bookKind = String(raw.book || raw.desk || 'live');
  const limits = await loadLimits(bookKind);
  const state = await loadRiskState();
  const key = bookKeyOf(bookKind) || 'live';
  const slice = bookState(state, key);
  const order = {
    ...raw,
    id: String(raw.id || raw.clientOrderId || raw.signal_id || '').trim() || randomUUID(),
    book: limits.book,
    desk: limits.desk,
    accountId: raw.accountId || (key === 'live' ? 'agentic' : `paper-${key}`),
    symbol: String(raw.symbol || '').toUpperCase(),
    side: String(raw.side || '').toLowerCase(),
    instrument: String(raw.instrument || raw.asset_type || 'equity').toLowerCase()
  };

  const book = await snapshotFor(limits.book, state);
  limits.caps = resolveCaps(book.nav, limits);
  const modeInfo = resolveMode(book, limits, slice);
  book.mode = modeInfo.mode;
  book.modeReason = modeInfo.reason;

  const decision = assertOrder(order, book, limits, {
    now: Date.now(),
    seen: state.seenOrderIds,
    book: limits.book,
    accountId: order.accountId,
    mode: modeInfo.mode,
    modeReason: modeInfo.reason,
    rejectCount: slice.rejectCount || 0
  });
  decision.order = {
    id: order.id,
    book: order.book,
    desk: order.desk,
    accountId: order.accountId,
    symbol: order.symbol,
    side: order.side,
    instrument: order.instrument,
    qty: order.qty,
    limitPrice: order.limitPrice ?? order.price ?? null,
    stopPrice: order.stopPrice ?? null,
    maxLoss: decision.risk ?? order.maxLoss ?? null
  };
  decision.limits = {
    book: limits.book,
    desk: limits.desk,
    phase: limits.phase,
    caps: limits.caps,
    maxPositions: limits.caps.maxPositions,
    maxOrderRiskPct: limits.maxOrderRiskPct,
    maxDailyLossPct: limits.maxDailyLossPct
  };
  decision.liveTrading = false;
  const next = await rememberOrder(state, decision);
  return { decision, book, mode: modeInfo, state: next };
}

export async function getRiskView(book = 'live') {
  const limits = await loadLimits(book);
  const state = await loadRiskState();
  const snap = await snapshotFor(limits.book, state);
  limits.caps = resolveCaps(snap.nav, limits);
  const mode = resolveMode(snap, limits, bookState(state, limits.desk === 'live' ? 'live' : limits.desk));
  return {
    ok: true,
    date: todayStamp(),
    liveTrading: false,
    phase: limits.phase,
    mode: mode.mode,
    modeReason: mode.reason,
    configured: snap.holdingsConfigured !== false,
    locked: mode.locked,
    limits,
    caps: limits.caps,
    kill: mode.mode === 'KILL',
    killReason: mode.reason,
    book: snap,
    lastCheck: state.lastCheck
  };
}

export { setKill, setMode, saveRiskState };
