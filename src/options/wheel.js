import { blackScholes } from './math.js';

export const WHEEL_MIN_DTE = 7;
export const WHEEL_MAX_DTE = 45;
export const WHEEL_DELTA_LOW = 0.2;
export const WHEEL_DELTA_HIGH = 0.3;
export const WHEEL_DELTA_TARGET = 0.25;
export const WHEEL_SEED = 100_000;
export const CONTRACT_SHARES = 100;
export const QUOTE_STATUS = 'delayed-reference';
export const QUOTE_NOTE = '延迟/参考报价，不是成交价。纸上轮证，不下真实单。股价下跌时亏损可以大于权利金。';

const PHASE = {
  PUT: 'short-put',
  STOCK: 'long-stock',
  CALL: 'covered-call'
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function px(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function clone(ledger) {
  return structuredClone(ledger);
}

function fail(error) {
  return { ok: false, error, liveTrading: false };
}

function daysBetween(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000));
}

export function supportFromBars(bars, lookback = 20) {
  const lows = (bars || []).slice(-lookback).map((bar) => num(bar.low)).filter((n) => n > 0);
  if (!lows.length) return null;
  return Math.min(...lows);
}

export function annualizedYield(premium, capitalPerShare, dte) {
  const credit = num(premium);
  const capital = num(capitalPerShare);
  const days = num(dte);
  if (!(credit > 0) || !(capital > 0) || !(days > 0)) return null;
  return (credit / capital) * (365 / days);
}

function ivDecimal(iv) {
  const n = num(iv);
  if (!(n > 0)) return null;
  return n > 3 ? n / 100 : n;
}

function legDte(leg, fallback) {
  return num(leg?.dte) ?? num(fallback);
}

function absDelta(leg, spot, dte) {
  const given = num(leg?.delta);
  if (given != null) return { delta: Math.abs(given), source: 'chain' };
  const iv = ivDecimal(leg?.iv);
  if (!(iv > 0) || !(spot > 0) || !(dte > 0)) return { delta: null, source: 'unknown' };
  const model = blackScholes({ spot, strike: leg.strike, dte, iv, type: leg.type === 'call' ? 'call' : 'put' });
  if (!model || !Number.isFinite(model.delta)) return { delta: null, source: 'unknown' };
  return { delta: Math.abs(model.delta), source: 'model' };
}

function liquid(leg) {
  const bid = num(leg?.bid);
  const ask = num(leg?.ask);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return false;
  const volume = num(leg.volume);
  const openInterest = num(leg.openInterest);
  if (volume == null && openInterest == null) return false;
  return (volume || 0) > 0 || (openInterest || 0) > 0;
}

function inDeltaBand(delta, low = WHEEL_DELTA_LOW, high = WHEEL_DELTA_HIGH) {
  return delta != null && delta + 1e-9 >= low && delta - 1e-9 <= high;
}

function candidateFrom(leg, { side, spot, dte, delta, deltaSource, support, source }) {
  const premium = num(leg.bid);
  const strike = num(leg.strike);
  const mid = num(leg.mid);
  const capital = side === 'put' ? strike : strike;
  return {
    side,
    strike,
    premium,
    premiumMid: mid,
    expiration: leg.expiration || null,
    dte,
    delta,
    deltaSource,
    yield: premium / capital,
    annualizedYield: annualizedYield(premium, capital, dte),
    breakeven: side === 'put' ? px(strike - premium) : px(strike + premium),
    cashReserved: side === 'put' ? money(strike * CONTRACT_SHARES) : 0,
    support: support ?? null,
    belowSupport: support != null && strike <= support,
    source: source || leg.source || null,
    quoteStatus: QUOTE_STATUS,
    quoteNote: QUOTE_NOTE,
    volume: num(leg.volume),
    openInterest: num(leg.openInterest),
    iv: ivDecimal(leg.iv)
  };
}

export function selectCashSecuredPut({
  puts = [],
  spot,
  support = null,
  dte: fallbackDte = null,
  expiration = null,
  source = null,
  minDte = WHEEL_MIN_DTE,
  maxDte = WHEEL_MAX_DTE,
  deltaLow = WHEEL_DELTA_LOW,
  deltaHigh = WHEEL_DELTA_HIGH
} = {}) {
  const price = num(spot);
  if (!(price > 0)) return null;
  const rows = [];
  for (const leg of puts) {
    const strike = num(leg?.strike);
    const dte = legDte(leg, fallbackDte);
    if (!(strike > 0) || strike >= price) continue;
    if (!(dte >= minDte && dte <= maxDte)) continue;
    if (!liquid(leg)) continue;
    const { delta, source: deltaSource } = absDelta({ ...leg, type: 'put' }, price, dte);
    const band = inDeltaBand(delta, deltaLow, deltaHigh);
    const below = support != null && strike <= support;
    if (!band && !below) continue;
    const picked = candidateFrom(
      { ...leg, expiration: leg.expiration || expiration },
      { side: 'put', spot: price, dte, delta, deltaSource, support, source }
    );
    rows.push({ ...picked, band });
  }
  rows.sort((a, b) => {
    if (a.band !== b.band) return a.band ? -1 : 1;
    const da = a.delta == null ? 9 : Math.abs(a.delta - WHEEL_DELTA_TARGET);
    const db = b.delta == null ? 9 : Math.abs(b.delta - WHEEL_DELTA_TARGET);
    if (Math.abs(da - db) > 1e-6) return da - db;
    return (b.annualizedYield || 0) - (a.annualizedYield || 0) || b.strike - a.strike;
  });
  if (!rows.length) return null;
  const { band, ...best } = rows[0];
  return best;
}

export function selectCoveredCall({
  calls = [],
  spot,
  costBasis,
  dte: fallbackDte = null,
  expiration = null,
  source = null,
  minDte = WHEEL_MIN_DTE,
  maxDte = WHEEL_MAX_DTE,
  deltaLow = WHEEL_DELTA_LOW,
  deltaHigh = WHEEL_DELTA_HIGH
} = {}) {
  const price = num(spot);
  const basis = num(costBasis);
  if (!(price > 0) || !(basis > 0)) return null;
  const floor = Math.max(basis, price);
  const rows = [];
  for (const leg of calls) {
    const strike = num(leg?.strike);
    const dte = legDte(leg, fallbackDte);
    if (!(strike > floor)) continue;
    if (!(dte >= minDte && dte <= maxDte)) continue;
    if (!liquid(leg)) continue;
    const { delta, source: deltaSource } = absDelta({ ...leg, type: 'call' }, price, dte);
    if (!inDeltaBand(delta, deltaLow, deltaHigh)) continue;
    rows.push(candidateFrom(
      { ...leg, expiration: leg.expiration || expiration },
      { side: 'call', spot: price, dte, delta, deltaSource, support: null, source }
    ));
  }
  rows.sort((a, b) => {
    const da = Math.abs((a.delta ?? 9) - WHEEL_DELTA_TARGET);
    const db = Math.abs((b.delta ?? 9) - WHEEL_DELTA_TARGET);
    if (Math.abs(da - db) > 1e-6) return da - db;
    return (b.annualizedYield || 0) - (a.annualizedYield || 0) || a.strike - b.strike;
  });
  return rows[0] || null;
}

export function wheelCandidatesFromContexts(contexts = []) {
  const out = [];
  for (const ctx of contexts) {
    const puts = ctx?.chain?.puts || [];
    if (!puts.length || !(num(ctx.last) > 0)) continue;
    const support = supportFromBars(ctx.daily);
    const pick = selectCashSecuredPut({
      puts,
      spot: ctx.last,
      support,
      dte: ctx.chain?.dte,
      expiration: ctx.chain?.expiration,
      source: ctx.chain?.source || ctx.quoteSource || null
    });
    if (!pick) continue;
    out.push({
      symbol: String(ctx.symbol || '').toUpperCase(),
      name: ctx.name || ctx.symbol,
      from: ctx.from || null,
      spot: ctx.last,
      ...pick,
      support
    });
  }
  out.sort((a, b) => (b.annualizedYield || 0) - (a.annualizedYield || 0) || String(a.symbol).localeCompare(String(b.symbol)));
  return out;
}

export function emptyWheelLedger(now = new Date().toISOString()) {
  return {
    id: 'paper-wheel',
    type: 'paper-wheel',
    liveTrading: false,
    seed: WHEEL_SEED,
    cash: WHEEL_SEED,
    reservedCash: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    equity: WHEEL_SEED,
    peakEquity: WHEEL_SEED,
    maxDrawdown: 0,
    maxDrawdownUsd: 0,
    quoteStatus: QUOTE_STATUS,
    quoteNote: QUOTE_NOTE,
    note: '独立纸上轮证账本，不写进 0A–0H，不写推荐 / 模拟 / 实际操作，不下真实单。',
    updatedAt: now,
    positions: {},
    closedCycles: []
  };
}

function normalizeSymbol(symbol) {
  const key = String(symbol || '').toUpperCase();
  return /^[A-Z][A-Z.]{0,4}$/.test(key) ? key : null;
}

function listedDays(row, asOf) {
  const given = num(row.leg?.dte);
  if (given > 0) return given;
  if (row.leg?.expiration) return daysBetween(asOf, `${row.leg.expiration}T00:00:00.000Z`);
  return 0;
}

function cycleAnnualized(row, asOf) {
  const capital = num(row.capitalAtRisk) || (num(row.costBasis) > 0 ? row.costBasis * CONTRACT_SHARES : 0);
  if (!(capital > 0) || !(row.premiumIncome > 0)) return null;
  const horizon = Math.max(daysBetween(row.openedAt, asOf), num(row.horizonDays) || 0, listedDays(row, asOf), 1);
  return (row.premiumIncome / capital) * (365 / horizon);
}

function positionUnrealized(row, spot) {
  if (!(spot > 0)) return 0;
  if (row.phase === PHASE.PUT && row.leg) {
    const intrinsic = Math.max(0, row.leg.strike - spot);
    return money((row.leg.premium - intrinsic) * CONTRACT_SHARES);
  }
  if (row.phase === PHASE.CALL && row.leg) {
    const intrinsic = Math.max(0, spot - row.leg.strike);
    const stock = (spot - row.costBasis) * row.shares;
    const call = (row.leg.premium - intrinsic) * CONTRACT_SHARES;
    return money(stock + call);
  }
  if (row.phase === PHASE.STOCK && row.shares > 0 && row.costBasis != null) {
    return money((spot - row.costBasis) * row.shares);
  }
  return 0;
}

export function markWheel(ledger, spots = {}, asOf = new Date().toISOString()) {
  const next = clone(ledger);
  let stockValue = 0;
  let optionLiability = 0;
  for (const row of Object.values(next.positions || {})) {
    const spot = num(spots[row.symbol]) ?? num(row.last);
    if (spot > 0) row.last = spot;
    const mark = spot > 0 ? spot : (num(row.costBasis) || 0);
    if (row.shares > 0 && mark > 0) stockValue += row.shares * mark;
    if (row.phase === PHASE.PUT && row.leg && spot > 0) {
      optionLiability += Math.max(0, row.leg.strike - spot) * CONTRACT_SHARES;
    } else if (row.phase === PHASE.CALL && row.leg && spot > 0) {
      optionLiability += Math.max(0, spot - row.leg.strike) * CONTRACT_SHARES;
    }
    row.unrealizedPnl = positionUnrealized(row, spot || 0);
    row.annualizedYield = cycleAnnualized(row, asOf);
    row.quoteStatus = QUOTE_STATUS;
  }
  const equity = money(next.cash + stockValue - optionLiability);
  const unrealized = money(Object.values(next.positions || {}).reduce((sum, row) => sum + (row.unrealizedPnl || 0), 0));
  next.equity = equity;
  next.unrealizedPnl = unrealized;
  next.peakEquity = Math.max(num(next.peakEquity) || next.seed, equity);
  const drop = next.peakEquity - equity;
  if (drop > (num(next.maxDrawdownUsd) || 0) + 1e-9) {
    next.maxDrawdownUsd = money(drop);
    next.maxDrawdown = next.peakEquity > 0 ? px(drop / next.peakEquity) : 0;
  }
  next.reservedCash = money(Object.values(next.positions || {}).reduce((sum, row) => (
    sum + (row.phase === PHASE.PUT && row.leg ? row.leg.strike * CONTRACT_SHARES : 0)
  ), 0));
  next.liveTrading = false;
  next.quoteStatus = QUOTE_STATUS;
  next.updatedAt = asOf;
  return next;
}

function legOf(input, side) {
  const strike = num(input.strike);
  const premium = num(input.premium);
  const expiration = String(input.expiration || '');
  if (!(strike > 0) || !(premium > 0)) return { error: '行权价和权利金必须为正' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return { error: '到期日须为 YYYY-MM-DD' };
  return {
    leg: {
      side,
      strike,
      premium: px(premium),
      expiration,
      dte: num(input.dte),
      delta: num(input.delta)
    }
  };
}

export function openCashSecuredPut(ledger, input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return fail('代码无效');
  const built = legOf(input, 'put');
  if (built.error) return fail(built.error);
  const existing = ledger.positions?.[symbol];
  if (existing && existing.phase !== 'cash') return fail(`${symbol} 不在现金阶段，不能再卖现金担保认沽`);
  const reserved = built.leg.strike * CONTRACT_SHARES;
  const free = (num(ledger.cash) || 0) - (num(ledger.reservedCash) || 0);
  if (free + 1e-6 < reserved) return fail(`可用现金 ${money(free)} 不够锁定 ${money(reserved)}（行权价×100）`);
  const now = input.asOf || new Date().toISOString();
  const next = clone(ledger);
  const credit = money(built.leg.premium * CONTRACT_SHARES);
  next.cash = money(next.cash + credit);
  const horizonDays = num(input.dte) || daysBetween(now, `${built.leg.expiration}T00:00:00.000Z`);
  next.positions[symbol] = {
    symbol,
    phase: PHASE.PUT,
    shares: 0,
    costBasis: null,
    premiumsPerShare: built.leg.premium,
    premiumIncome: credit,
    capitalAtRisk: reserved,
    horizonDays,
    assignments: 0,
    calledAway: 0,
    rolls: input.roll ? (Number(input.priorRolls) || 0) + 1 : 0,
    openedAt: now,
    last: num(input.spot),
    leg: { ...built.leg, openedAt: now },
    history: [{ at: now, event: 'sell-put', strike: built.leg.strike, premium: built.leg.premium, cashReserved: reserved }],
    quoteStatus: QUOTE_STATUS
  };
  return { ok: true, liveTrading: false, ledger: markWheel(next, input.spot ? { [symbol]: input.spot } : {}, now), symbol };
}

export function openCoveredCall(ledger, input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return fail('代码无效');
  const row = ledger.positions?.[symbol];
  if (!row || row.phase !== PHASE.STOCK || !(row.shares >= CONTRACT_SHARES)) {
    return fail(`${symbol} 需要先持有 100 股，才能卖备兑认购`);
  }
  const built = legOf(input, 'call');
  if (built.error) return fail(built.error);
  if (!(built.leg.strike > row.costBasis)) return fail(`备兑认购行权价须高于成本 ${row.costBasis}`);
  const now = input.asOf || new Date().toISOString();
  const next = clone(ledger);
  const held = next.positions[symbol];
  const credit = money(built.leg.premium * CONTRACT_SHARES);
  next.cash = money(next.cash + credit);
  held.premiumIncome = money(held.premiumIncome + credit);
  held.horizonDays = Math.max(num(held.horizonDays) || 0, num(input.dte) || daysBetween(now, `${built.leg.expiration}T00:00:00.000Z`));
  held.phase = PHASE.CALL;
  held.rolls = input.roll ? (Number(held.rolls) || 0) + 1 : (Number(held.rolls) || 0);
  held.leg = { ...built.leg, openedAt: now };
  held.history = [...(held.history || []), { at: now, event: 'sell-call', strike: built.leg.strike, premium: built.leg.premium }];
  if (num(input.spot) > 0) held.last = num(input.spot);
  return { ok: true, liveTrading: false, ledger: markWheel(next, input.spot ? { [symbol]: input.spot } : {}, now), symbol };
}

function closeCycle(row, now, event, spot) {
  return {
    symbol: row.symbol,
    event,
    spot: num(spot),
    premiumIncome: row.premiumIncome,
    assignments: row.assignments,
    calledAway: row.calledAway,
    costBasis: row.costBasis,
    capitalAtRisk: row.capitalAtRisk,
    rolls: row.rolls,
    openedAt: row.openedAt,
    closedAt: now,
    days: daysBetween(row.openedAt, now),
    annualizedYield: cycleAnnualized(row, now),
    history: row.history,
    quoteStatus: QUOTE_STATUS
  };
}

export function settleWheel(ledger, input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return fail('代码无效');
  const row = ledger.positions?.[symbol];
  if (!row) return fail('没有这个标的的轮证仓');
  const spot = num(input.spot);
  if (!(spot > 0)) return fail('需要现价才能结算');
  if (row.phase === PHASE.STOCK) return fail('还没有卖出备兑认购，无法按期权到期结算');
  if (row.phase !== PHASE.PUT && row.phase !== PHASE.CALL) return fail('当前阶段没有未到期合约');
  const now = input.asOf || new Date().toISOString();
  const next = clone(ledger);
  const held = next.positions[symbol];
  held.last = spot;
  if (held.phase === PHASE.PUT) {
    const itm = spot < held.leg.strike;
    if (itm) {
      next.cash = money(next.cash - held.leg.strike * CONTRACT_SHARES);
      held.shares = CONTRACT_SHARES;
      held.costBasis = px(held.leg.strike - held.premiumsPerShare);
      held.assignments += 1;
      held.phase = PHASE.STOCK;
      held.history = [...held.history, {
        at: now,
        event: 'assigned',
        spot,
        strike: held.leg.strike,
        costBasis: held.costBasis,
        shares: CONTRACT_SHARES
      }];
      held.leg = null;
    } else {
      next.realizedPnl = money(next.realizedPnl + held.premiumIncome);
      held.history = [...held.history, { at: now, event: 'put-otm', spot, strike: held.leg.strike, premium: held.leg.premium }];
      next.closedCycles = [...(next.closedCycles || []), closeCycle(held, now, 'put-otm', spot)];
      delete next.positions[symbol];
    }
  } else if (spot > held.leg.strike) {
    const basis = px(held.costBasis - held.leg.premium);
    const gain = money((held.leg.strike - basis) * held.shares);
    next.cash = money(next.cash + held.leg.strike * held.shares);
    next.realizedPnl = money(next.realizedPnl + gain);
    held.calledAway += 1;
    held.shares = 0;
    held.costBasis = basis;
    held.phase = 'cash';
    held.history = [...held.history, { at: now, event: 'called-away', spot, strike: held.leg.strike, realized: gain, costBasis: basis }];
    next.closedCycles = [...(next.closedCycles || []), closeCycle(held, now, 'called-away', spot)];
    delete next.positions[symbol];
  } else {
    held.costBasis = px(held.costBasis - held.leg.premium);
    held.premiumsPerShare = px((held.premiumsPerShare || 0) + held.leg.premium);
    held.phase = PHASE.STOCK;
    held.history = [...held.history, {
      at: now,
      event: 'call-otm',
      spot,
      strike: held.leg.strike,
      premium: held.leg.premium,
      costBasis: held.costBasis
    }];
    held.leg = null;
  }
  return { ok: true, liveTrading: false, ledger: markWheel(next, { [symbol]: spot }, now), symbol };
}

export function rollWheel(ledger, input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return fail('代码无效');
  const existing = ledger.positions?.[symbol];
  let current = ledger;
  const priorRolls = existing?.rolls || 0;
  if (existing && (existing.phase === PHASE.PUT || existing.phase === PHASE.CALL)) {
    const settled = settleWheel(current, input);
    if (!settled.ok) return settled;
    current = settled.ledger;
  }
  const settled = { ok: true, liveTrading: false, ledger: markWheel(current, input.spot ? { [symbol]: input.spot } : {}, input.asOf), symbol };
  const candidate = input.candidate;
  if (!candidate) return settled;
  const after = current.positions?.[symbol];
  if (!after) {
    if (candidate.side === 'call') return { ...settled, warning: '认沽已结算。现金阶段只能再卖认沽。' };
    const opened = openCashSecuredPut(current, { ...candidate, symbol, asOf: input.asOf, spot: input.spot, roll: true, priorRolls });
    return opened.ok ? opened : { ...settled, warning: opened.error };
  }
  if (after.phase === PHASE.STOCK) {
    if (candidate.side !== 'call') return { ...settled, warning: '已结算并持股。请卖出行权价高于成本的备兑认购。' };
    const opened = openCoveredCall(current, { ...candidate, symbol, asOf: input.asOf, spot: input.spot, roll: true });
    return opened.ok ? opened : { ...settled, warning: opened.error };
  }
  return settled;
}

export function bookPremiumYield(ledger, asOf = new Date().toISOString()) {
  const rows = [...Object.values(ledger.positions || {}), ...(ledger.closedCycles || [])];
  const income = rows.reduce((sum, row) => sum + (num(row.premiumIncome) || 0), 0);
  const opened = rows.map((row) => Date.parse(row.openedAt)).filter((t) => Number.isFinite(t));
  if (!opened.length || !(ledger.seed > 0) || !(income > 0)) return null;
  const elapsed = Math.max(1, Math.round((Date.parse(asOf) - Math.min(...opened)) / 86400000));
  const listed = Object.values(ledger.positions || {}).map((row) => Math.max(num(row.horizonDays) || 0, listedDays(row, asOf))).filter((n) => n > 0);
  const horizon = Math.max(elapsed, listed.length ? Math.min(...listed) : 0, 1);
  return (income / ledger.seed) * (365 / horizon);
}
