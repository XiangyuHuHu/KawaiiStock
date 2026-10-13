import { isUsSessionDay } from './paths.js';

/** 模拟仓每日建仓。只给推荐里已经写明的 BUY/ADD 定量，不新造标的。 */
export const BUILD_POLICY = {
  main: { tranchePct: 0.025, targetPct: 0.06, cashFloorPct: 0.10, maxBuilds: 4 },
  tactical: { tranchePct: 0.022, targetPct: 0.06, cashFloorPct: 0.15, maxBuilds: 6 },
  agentic: { tranchePct: 0.025, targetPct: 0.08, cashFloorPct: 0.25, maxBuilds: 2, maxPositions: 5 }
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function addDays(stamp, days) {
  const [y, m, d] = String(stamp).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function nextSessionStamp(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  for (let i = 1; i <= 10; i += 1) {
    const next = addDays(day, i);
    if (isUsSessionDay(next)) return next;
  }
  return null;
}

function positionValue(pos) {
  if (pos?.marketValue != null && Number.isFinite(Number(pos.marketValue))) return Number(pos.marketValue);
  const qty = Number(pos?.qty) || 0;
  const px = Number(pos?.last ?? pos?.avgCost) || 0;
  return qty * px;
}

export function bookNav(book) {
  const equity = (book?.positions || []).reduce((sum, row) => sum + positionValue(row), 0);
  return Math.round(((Number(book?.cash) || 0) + equity) * 100) / 100;
}

function weightOf(book, symbol, nav) {
  if (!(nav > 0)) return 0;
  const pos = (book?.positions || []).find((row) => String(row.symbol || '').toUpperCase() === symbol);
  return pos ? positionValue(pos) / nav : 0;
}

function decisionPrice(rec, book, symbol) {
  const last = num(rec.last);
  if (last > 0) return last;
  const pos = (book?.positions || []).find((row) => String(row.symbol || '').toUpperCase() === symbol);
  const px = num(pos?.last);
  return px > 0 ? px : null;
}

function holdBuild(fromPct, reason) {
  return { fromPct, toPct: fromPct, label: 'HOLD', decision: null, reason: reason || null };
}

/**
 * 给缺少股数的 BUY/ADD 补上一笔建仓数量。已有正股数的订单不改。
 * 返回新数组，不改原推荐，也不改账本。
 */
export function sizeBuild(book, recs, accountId) {
  const policy = BUILD_POLICY[accountId] || BUILD_POLICY.main;
  const nav = bookNav(book);
  const cash = Number(book?.cash) || 0;
  const spendable = Math.max(0, cash - nav * policy.cashFloorPct);
  const held = new Set((book?.positions || []).map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean));
  let spent = 0;
  let builds = 0;
  let newNames = 0;

  return (recs || []).map((rec) => {
    const action = String(rec.action || 'HOLD').toUpperCase();
    const symbol = String(rec.symbol || '').toUpperCase();
    const fromPct = round1(weightOf(book, symbol, nav) * 100);
    const copy = { ...rec };
    if (!symbol || !['BUY', 'ADD'].includes(action)) {
      let toPct = fromPct;
      const label = action === 'HOLD' || action === 'WATCH' ? 'HOLD' : action;
      if (action === 'EXIT' || action === 'SELL') toPct = 0;
      else if (action === 'TRIM') toPct = round1(fromPct / 2);
      copy.build = { fromPct, toPct, label, decision: null, reason: null };
      return copy;
    }

    const price = decisionPrice(rec, book, symbol);
    const explicit = num(rec.tradeQty);
    if (explicit != null && explicit > 0) {
      const addPct = nav > 0 && price > 0 ? (explicit * price) / nav * 100 : 0;
      const toPct = round1(fromPct + addPct);
      copy.build = {
        fromPct,
        toPct,
        label: addPct >= 4 ? 'STRONG_ADD' : 'ADD',
        decision: price,
        explicit: true,
        reason: null
      };
      return copy;
    }
    if (explicit != null) {
      copy.build = holdBuild(fromPct, '无效数量，不建仓');
      return copy;
    }
    if (!(price > 0) || !(nav > 0)) {
      copy.build = holdBuild(fromPct, '没有决策价，不建仓');
      return copy;
    }
    if (fromPct + 1e-6 >= policy.targetPct * 100) {
      copy.build = holdBuild(fromPct, '已到目标权重');
      return copy;
    }
    if (builds >= policy.maxBuilds) {
      copy.build = holdBuild(fromPct, '本日建仓名额已满');
      return copy;
    }
    if (!held.has(symbol) && policy.maxPositions != null && held.size + newNames >= policy.maxPositions) {
      copy.build = holdBuild(fromPct, '持仓数已满');
      return copy;
    }

    const gapPct = policy.targetPct * 100 - fromPct;
    const tranchePct = Math.min(policy.tranchePct * 100, gapPct);
    let notional = nav * (tranchePct / 100);
    const room = spendable - spent;
    if (notional > room) notional = room;
    const qty = Math.floor((notional / price) * 10000) / 10000;
    if (!(qty > 0) || qty * price < 1) {
      copy.build = holdBuild(fromPct, '现金不够建仓');
      return copy;
    }

    const cost = qty * price;
    spent += cost;
    builds += 1;
    if (!held.has(symbol)) newNames += 1;
    const toPct = round1(fromPct + (cost / nav) * 100);
    const label = (toPct - fromPct) >= 4 ? 'STRONG_ADD' : 'ADD';
    copy.tradeQty = qty;
    copy.build = { fromPct, toPct, label, decision: price, tranche: true, reason: null };
    return copy;
  });
}

export function phaseOf(cashPct, accountId) {
  const policy = BUILD_POLICY[accountId] || BUILD_POLICY.main;
  if (cashPct >= 0.7) return 'RAMP_UP';
  if (cashPct > policy.cashFloorPct + 0.02) return 'DEPLOY';
  return 'STEADY';
}

export function buildCard(book, sized, accountId, { signalDate, executeDate, settled } = {}) {
  const policy = BUILD_POLICY[accountId] || BUILD_POLICY.main;
  const nav = bookNav(book);
  const cash = Math.round((Number(book?.cash) || 0) * 100) / 100;
  const cashPct = nav > 0 ? cash / nav : 0;
  const actions = (sized || []).filter((row) => {
    const label = row.build?.label || String(row.action || '').toUpperCase();
    if (!row.symbol) return false;
    if (['WATCH', 'REVIEW', 'WAIT', 'OPTION', 'MISSING'].includes(label)) return false;
    if (label === 'HOLD' && !(Number(row.build?.fromPct) > 0)) return false;
    if (!(Number(row.build?.fromPct) > 0) && !(Number(row.build?.toPct) > 0)) return false;
    return true;
  }).map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    action: row.build?.label || String(row.action || 'HOLD').toUpperCase(),
    fromPct: row.build?.fromPct ?? 0,
    toPct: row.build?.toPct ?? row.build?.fromPct ?? 0,
    reason: row.build?.reason || null
  }));
  const pending = (sized || []).filter((row) => {
    const label = row.build?.label;
    return (label === 'ADD' || label === 'STRONG_ADD') && num(row.tradeQty) > 0;
  }).map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    side: 'buy',
    qty: num(row.tradeQty),
    decision: row.build?.decision ?? null,
    expires: executeDate
  }));
  return {
    id: accountId,
    label: book?.label || accountId,
    nav,
    cash,
    cashPct: round1(cashPct * 100),
    positionCount: (book?.positions || []).filter((row) => Number(row.qty) > 0).length,
    phase: phaseOf(cashPct, accountId),
    targetPct: round1(policy.targetPct * 100),
    tranchePct: round1(policy.tranchePct * 100),
    signalDate: signalDate || null,
    executeDate: executeDate || null,
    settled: Boolean(settled),
    actions,
    pending
  };
}
