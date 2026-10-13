export const MODES = ['NORMAL', 'NOT_CONFIGURED', 'REDUCE_ONLY', 'PROTECT', 'KILL'];

const RANK = {
  NORMAL: 0,
  NOT_CONFIGURED: 1,
  REDUCE_ONLY: 1,
  PROTECT: 2,
  KILL: 3
};

export function modeRank(mode) {
  return RANK[String(mode || 'NORMAL').toUpperCase()] ?? 0;
}

export function worseMode(a, b) {
  return modeRank(a) >= modeRank(b) ? String(a || 'NORMAL').toUpperCase() : String(b || 'NORMAL').toUpperCase();
}

export function canOpen(mode) {
  return String(mode || 'NORMAL').toUpperCase() === 'NORMAL';
}

export function canReduce(mode) {
  return MODES.includes(String(mode || 'NORMAL').toUpperCase());
}

/** PROTECT / KILL 只能人工 confirm 后降级。AI 不得自行恢复。 */
export function canRestore(from, to, { confirm } = {}) {
  if (modeRank(to) >= modeRank(from)) return true;
  if (modeRank(from) >= RANK.PROTECT) return Boolean(confirm);
  return true;
}

export function deriveAutoMode(book = {}, limits = {}, extras = {}) {
  const nav = Number(book.nav);
  const peak = Number(book.peakNav) || nav;
  const dailyLoss = Math.abs(Math.min(0, Number(book.realizedPnlToday) || 0));
  const weeklyLoss = Math.abs(Math.min(0, Number(book.realizedPnlWeek) || 0));
  const caps = limits.caps || {};

  if (book.kill) return { mode: 'KILL', reason: book.killReason || book.modeReason || 'kill' };
  if (book.reconMismatch) return { mode: 'KILL', reason: '本地持仓与券商不一致' };
  if (peak > 0 && Number.isFinite(nav) && limits.killDrawdownPct != null) {
    const dd = ((peak - nav) / peak) * 100;
    if (dd >= Number(limits.killDrawdownPct)) {
      return { mode: 'KILL', reason: `峰值回撤 ${dd.toFixed(1)}% ≥ ${limits.killDrawdownPct}%` };
    }
  }
  if (peak > 0 && Number.isFinite(nav) && limits.protectDrawdownPct != null) {
    const dd = ((peak - nav) / peak) * 100;
    if (dd >= Number(limits.protectDrawdownPct)) {
      return { mode: 'PROTECT', reason: `峰值回撤 ${dd.toFixed(1)}% ≥ ${limits.protectDrawdownPct}%` };
    }
  }
  if (caps.maxWeeklyLoss != null && weeklyLoss >= Number(caps.maxWeeklyLoss)) {
    return { mode: 'PROTECT', reason: `本周亏损 $${weeklyLoss.toFixed(2)} 达上限` };
  }
  if (caps.maxDailyLoss != null && dailyLoss >= Number(caps.maxDailyLoss)) {
    return { mode: 'REDUCE_ONLY', reason: `当日亏损 $${dailyLoss.toFixed(2)} 达上限` };
  }
  if ((extras.rejectCount || 0) >= (limits.maxRejectsPerDay || 5)) {
    return { mode: 'REDUCE_ONLY', reason: `当日拒单 ${(extras.rejectCount || 0)} 次，暂停新开仓` };
  }
  if (book.book === 'live' && book.holdingsConfigured === false) {
    return { mode: 'NOT_CONFIGURED', reason: '持仓档案未配置' };
  }
  if (book.holdingsFresh === false && book.book === 'live') {
    return { mode: 'REDUCE_ONLY', reason: '持仓档案不是今日实时' };
  }
  if (book.dataUnhealthy && book.book === 'live') {
    return { mode: 'REDUCE_ONLY', reason: '关键数据不健康' };
  }
  return { mode: 'NORMAL', reason: null };
}

export function resolveMode(book, limits, stateSlice = {}) {
  const auto = deriveAutoMode(book, limits, { rejectCount: stateSlice.rejectCount || 0 });
  const manual = String(stateSlice.mode || 'NORMAL').toUpperCase();
  const mode = worseMode(manual, auto.mode);
  const reason = modeRank(auto.mode) >= modeRank(manual)
    ? (auto.reason || stateSlice.reason)
    : (stateSlice.reason || auto.reason);
  return {
    mode,
    reason,
    auto: auto.mode,
    manual,
    locked: modeRank(manual) >= RANK.PROTECT
  };
}
