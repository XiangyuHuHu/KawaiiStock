/** 0A = $1M 财富主账户。0B = $50k 进攻。0C = $5k Agentic。不是同一套仓位放大。 */
import { isCycleEntry as confirmedCycleEntry } from '../strategy/cycle.js';

export const OPEN = new Set(['BUY', 'ADD']);
export const CLOSE = new Set(['SELL', 'EXIT', 'TRIM']);

export const WEALTH_THEMES = {
  chip: { cap: 0.30, names: ['MU', 'MRVL', 'CRDO', 'INTC', 'NVDA', 'AVGO', 'TSM', 'AMAT', 'LRCX'] },
  ai: { cap: 0.25, names: ['NBIS', 'ORCL', 'IREN', 'PLTR', 'MSFT', 'AMZN', 'GOOGL', 'META'] },
  cyber: { cap: 0.20, names: ['PANW', 'CRWD', 'ZS', 'NET'] },
  power: { cap: 0.25, names: ['BE', 'CEG', 'SMR', 'OKLO', 'NNE', 'VST'] },
  cooling: { cap: 0.15, names: ['AAON', 'MOD', 'VRT', 'GLW'] },
  space: { cap: 0.10, names: ['RKLB', 'ASTS', 'LUNR'] }
};

export const DESK_POLICY = {
  '0a': {
    style: 'wealth',
    label: '财富逻辑',
    recId: 'main',
    maxNewOpens: 2,
    maxPositions: 10,
    firstTranchePct: 0.036,
    targetWeightPct: 0.12,
    cashFloorPct: 0.10,
    invalidationPct: 0.15,
    protectAtDrawdownPct: 12,
    tpTrimR: 3,
    tpTrimPct: 0.3,
    trailBeR: 1.5,
    trailLockR: 3
  },
  '0b': {
    style: 'tactical',
    label: '进攻逻辑',
    recId: 'tactical',
    maxNewOpens: 8,
    maxPositions: 16,
    firstTranchePct: 0.06,
    targetWeightPct: 0.08,
    cashFloorPct: 0.15,
    invalidationPct: 0.08,
    themeCapPct: 0.30,
    pauseNewAtDrawdownPct: 18,
    protectAtDrawdownPct: 12,
    tpTrimR: 2,
    tpTrimPct: 0.5,
    trailBeR: 1,
    trailLockR: 2
  },
  '0c': {
    style: 'agentic',
    label: 'Agentic Alpha',
    recId: 'agentic',
    maxNewOpens: 1,
    maxPositions: 3,
    firstTranchePct: 0.15,
    maxNamePct: 0.40,
    cashFloorPct: 0.25,
    invalidationPct: 0.08,
    noChasePct: 15,
    pauseNewAtDrawdownPct: 45,
    pauseNewAtDailyLossPct: 15,
    reduceSizeAtDrawdownPct: 15,
    tpTrimR: 2,
    tpTrimPct: 0.33,
    trailBeR: 1,
    trailLockR: 2
  },
  '0d': {
    style: 'oracle',
    label: '算卦对照',
    maxNewOpens: 5,
    maxPositions: 5,
    firstTranchePct: 0.08,
    cashFloorPct: 0.20,
    invalidationPct: 0.08,
    tpTrimR: 2,
    tpTrimPct: 0.33,
    trailBeR: 1,
    trailLockR: 2
  },
  '0e': {
    style: 'options',
    label: '期权对照',
    maxNewOpens: 1,
    maxPositions: 16,
    cashFloorPct: 0.40,
    maxNamePct: 0.15,
    takeProfitPct: 0.4,
    stopLossPct: 0.2,
    invalidationPct: 0.5
  },
  '0f': {
    style: 'momentum',
    label: 'Claude 动量',
    maxNewOpens: 2,
    maxPositions: 8,
    riskPct: 0.01,
    maxNamePct: 0.125,
    cashFloorPct: 0.05,
    atrMult: 3,
    keepRank: 20,
    noChasePct: 6,
    invalidationPct: 0.15
  },
  '0g': {
    style: 'xiaomeng-cn',
    label: '小孟A股',
    maxNewOpens: 2,
    maxPositions: 4,
    cashFloorPct: 0.10
  },
  '0h': {
    style: 'xiaomeng-us',
    label: '小孟美股',
    maxNewOpens: 2,
    maxPositions: 4,
    cashFloorPct: 0.10
  }
};

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function actionOf(row) {
  return String(row.action || row.side || '').toUpperCase();
}

export function isStock(row) {
  const inst = String(row.instrument || 'stock').toLowerCase();
  if (inst.includes('option') || inst.includes('2x') || inst.includes('3x')) return false;
  return /^[A-Z][A-Z.]{0,4}$/.test(String(row.symbol || '').toUpperCase());
}

export function wealthTheme(symbol) {
  const key = String(symbol || '').toUpperCase();
  for (const [theme, spec] of Object.entries(WEALTH_THEMES)) {
    if (spec.names.includes(key)) return theme;
  }
  return 'other';
}

export function isQualitySource(row) {
  const text = `${row.source || ''} ${row.title || ''} ${row.detail || ''}`;
  return /严选|primary|核心|中长期/i.test(text);
}

export function isHighOdds(row) {
  if (isCycleEntry(row)) return true;
  const text = `${row.source || ''} ${row.title || ''} ${row.detail || ''} ${row.instrument || ''}`;
  return /十倍|高Beta|激进|清单外|阿胡|option|2x|事件/i.test(text);
}

export function isCycleEntry(row, minScore = 80) {
  const s = row?.strategy;
  if (!s) return false;
  if (s.version) return confirmedCycleEntry(row, minScore);
  if (s.allowNewLong === true) return true;
  const stageOk = ['wedge-pop', 'ema-crossback', 'base-n-break'].includes(s.stage);
  return stageOk && Number(s.score) >= minScore && s.regime !== 'risk-off';
}

export function cycleSizeR(row) {
  const n = Number(row?.strategy?.sizeR);
  if (Number.isFinite(n) && n > 0) return n;
  if (row?.strategy?.stage === 'ema-crossback' || row?.strategy?.stage === 'base-n-break') return 1.25;
  if (row?.strategy?.stage === 'wedge-pop') return 1;
  return 1;
}

/** 0C 吃战术书：趋势/催化/波段。纯严选留给 0A，2x/期权自动不做。 */
export function tacticalRank(row) {
  const inst = String(row.instrument || 'stock').toLowerCase();
  if (inst.includes('option') || inst.includes('2x') || inst.includes('3x')) return -1;
  if (isCycleEntry(row)) return row.strategy?.stage === 'ema-crossback' ? 4 : 3;
  if (row?.strategy?.watch) return 2;
  const text = `${row.source || ''} ${row.title || ''} ${row.detail || ''}`;
  if (!/战术|催化|趋势|回踩|财报后|波段|高Beta|阿胡|Cycle|Wedge|Crossback|Base/i.test(text)) return -1;
  if (wealthRank(row) >= 3) return 1;
  if (/战术新机会|波段主仓|催化|回踩|财报后/.test(text)) return 3;
  return 2;
}

/** 0A 只吃严选/核心。十倍+阿胡的高赔率票留给 0B。分越高越像主账户标的。 */
export function wealthRank(row) {
  const src = String(row.source || '');
  const hasPrimary = /严选|primary|核心/.test(src);
  if (!hasPrimary && !isQualitySource(row)) return -1;
  if (/十倍|高Beta/.test(src) && !/严选|primary/.test(src)) return -1;
  if (/十倍|高Beta/.test(src)) return 1;
  if (/阿胡/.test(src)) return 2;
  if (/严选|primary/.test(src)) return isCycleEntry(row) ? 4 : 3;
  return isQualitySource(row) ? 2 : -1;
}

export function recBook(recs, id) {
  return (recs?.accounts || []).find((row) => row.id === id) || null;
}

export function drawdownPct(nav, peak) {
  if (!(peak > 0) || nav == null) return 0;
  return Math.max(0, ((peak - nav) / peak) * 100);
}

export function sizeAgentic(last, stop, cash, caps) {
  const riskPer = Math.abs(last - stop);
  if (!(last > 0) || !(riskPer > 0) || !(cash > 0)) return null;
  const byRisk = (num(caps.maxOrderRisk) || 0) / riskPer;
  const byCash = cash / last;
  let qty = Math.min(byRisk, byCash);
  qty = last >= 5 ? Math.floor(qty) : Math.floor(qty * 100) / 100;
  if (!(qty > 0) || qty * last < 1) return null;
  return { qty, maxLoss: Number((qty * riskPer).toFixed(2)) };
}

/** 0C：按净值 10–20% 开仓，现金底线 25%，单票不超过 40%。空仓合法。回撤则缩小。 */
export function sizeAlpha(last, stop, nav, cash, policy, ddPct = 0, sizeR = 1) {
  if (!(last > 0) || !(nav > 0)) return null;
  if (ddPct >= (policy.pauseNewAtDrawdownPct || 45)) return null;
  const floor = nav * (policy.cashFloorPct || 0.25);
  const spendable = Math.max(0, cash - floor);
  let pct = (policy.firstTranchePct || 0.15) * (Number(sizeR) > 0 ? Number(sizeR) : 1);
  if (ddPct >= 35) pct *= 0.25;
  else if (ddPct >= 25) pct *= 0.5;
  else if (ddPct >= (policy.reduceSizeAtDrawdownPct || 15)) pct *= 0.75;
  const maxName = nav * (policy.maxNamePct || 0.4);
  let notional = Math.min(nav * pct, spendable, maxName);
  if (!(notional > 0)) return null;
  let qty = last >= 5 ? Math.floor(notional / last) : Math.floor((notional / last) * 100) / 100;
  if (!(qty > 0) || qty * last < 1) return null;
  const riskPer = stop != null ? Math.abs(last - stop) : last * (policy.invalidationPct || 0.08);
  return { qty, maxLoss: Number((qty * riskPer).toFixed(2)) };
}

export function isChase(row, changePct, policy = {}) {
  const ch = num(row?.changePct) ?? num(changePct);
  return ch != null && ch >= (policy.noChasePct || 15);
}

/** 第一笔约目标仓的 30%（3.6% 净值，在 $1M 上约 $36k），现金底线 10%。 */
export function sizeWealth(last, stop, nav, cash, policy, themeNotional = 0, themeCap = null) {
  if (!(last > 0) || !(nav > 0)) return null;
  const floor = nav * (policy.cashFloorPct || 0.1);
  const spendable = Math.max(0, cash - floor);
  let notional = nav * (policy.firstTranchePct || 0.036);
  if (themeCap != null) {
    const room = Math.max(0, themeCap - themeNotional);
    notional = Math.min(notional, room);
  }
  notional = Math.min(notional, spendable);
  let qty = last >= 5 ? Math.floor(notional / last) : Math.floor((notional / last) * 100) / 100;
  if (!(qty > 0) || qty * last < 1) return null;
  const riskPer = stop != null ? Math.abs(last - stop) : last * (policy.invalidationPct || 0.15);
  return { qty, maxLoss: Number((qty * riskPer).toFixed(2)) };
}

export function themeNotional(positions, theme) {
  return (positions || []).reduce((sum, row) => {
    if (wealthTheme(row.symbol) !== theme) return sum;
    if (row.marketValue != null) return sum + Math.abs(Number(row.marketValue) || 0);
    return sum + Math.abs(Number(row.qty) || 0) * Number(row.last || row.avgCost || 0);
  }, 0);
}

export function wealthStop(last, failPrice, policy) {
  const wide = last * (1 - (policy.invalidationPct || 0.15));
  const rec = num(failPrice);
  if (rec != null && rec > 0 && rec < last) return Number(Math.min(rec, wide).toFixed(2));
  return Number(wide.toFixed(2));
}

/** 第一笔约 6% 净值（文档初始 5%–8%），现金底线 20%，主题名义 30%。 */
export function sizeTactical(last, stop, nav, cash, policy, themeUsed = 0) {
  if (!(last > 0) || !(nav > 0)) return null;
  const floor = nav * (policy.cashFloorPct || 0.2);
  const spendable = Math.max(0, cash - floor);
  const themeCap = nav * (policy.themeCapPct || 0.3);
  let notional = nav * (policy.firstTranchePct || 0.06);
  notional = Math.min(notional, Math.max(0, themeCap - themeUsed), spendable);
  let qty = last >= 5 ? Math.floor(notional / last) : Math.floor((notional / last) * 100) / 100;
  if (!(qty > 0) || qty * last < 1) return null;
  const riskPer = stop != null ? Math.abs(last - stop) : last * (policy.invalidationPct || 0.08);
  return { qty, maxLoss: Number((qty * riskPer).toFixed(2)) };
}

export function tacticalStop(last, failPrice, policy) {
  const wide = last * (1 - (policy.invalidationPct || 0.08));
  const rec = num(failPrice);
  if (rec != null && rec > 0 && rec < last) return Number(Math.min(rec, wide).toFixed(2));
  return Number(wide.toFixed(2));
}

export function rewardR(pos, last, policy = {}) {
  const cost = num(pos.avgCost);
  const px = num(last);
  if (!(cost > 0) || px == null) return 0;
  let risk = num(pos.riskPer);
  if (!(risk > 0)) {
    const entryStop = num(pos.entryStop);
    if (entryStop != null && cost > entryStop) risk = cost - entryStop;
  }
  if (!(risk > 0)) risk = cost * (policy.invalidationPct || 0.1);
  if (!(risk > 0)) return 0;
  return (px - cost) / risk;
}

export function recExitKind(row) {
  const action = actionOf(row);
  const stage = row?.strategy?.stage;
  const conf = Number(row?.strategy?.confidence || 0);
  if (stage === 'wedge-drop' && conf >= 0.55) return 'exit';
  if (stage === 'exhaustion-extension' && conf >= 0.55 && action !== 'SELL') return 'trim';
  if (['SELL', 'EXIT'].includes(action)) return 'exit';
  if (action !== 'TRIM') return null;
  const text = `${row.title || ''} ${row.detail || ''}`;
  if (/碎片|占位|1股|清理碎片/.test(text)) return null;
  if (/止盈|估值减|超限|减回|逻辑减|逻辑退|价格周期|Exhaustion/.test(text)) return 'trim';
  return null;
}

export function trailStop(pos, last, policy) {
  const cost = num(pos.avgCost);
  const cur = num(pos.stopPrice);
  const r = rewardR(pos, last, policy);
  if (!(cost > 0) || last == null || !(r > 0)) return cur;
  const risk = num(pos.riskPer) || (cost - (num(pos.entryStop) || 0)) || cost * (policy.invalidationPct || 0.1);
  let next = cur;
  if (r >= (policy.trailBeR || 1)) next = Math.max(next ?? 0, cost);
  if (r >= (policy.trailLockR || 2) && risk > 0) next = Math.max(next ?? 0, cost + risk);
  if (next != null && cur != null && next > cur + 1e-6 && next < last) return Number(next.toFixed(2));
  return cur;
}

/** 止损及时；止盈可以慢。没有卖点就 HOLD。 */
export function exitLabel(plan = {}) {
  const labels = {
    stop: '止损卖出',
    'logic-exit': '逻辑退出',
    tp: '止盈减仓',
    'rec-tp': '推荐止盈',
    trail: '上移止损，继续拿',
    hold: '没卖点，继续拿'
  };
  return labels[plan.reason] || (plan.action === 'SELL' ? '卖出' : plan.action === 'TRIM' ? '减仓' : '继续拿');
}

export function exitPlan(pos, last, recRow, policy) {
  const stop = num(pos.stopPrice);
  const qty = Number(pos.qty) || 0;
  if (!(qty > 0)) return { action: 'HOLD', reason: 'hold', qty: 0, trail: null };
  if (last != null && stop != null && last <= stop) {
    return { action: 'SELL', reason: 'stop', qty, trail: null };
  }
  const recKind = recRow ? recExitKind(recRow) : null;
  if (recKind === 'exit') return { action: 'SELL', reason: 'logic-exit', qty, trail: null };
  const r = rewardR(pos, last, policy);
  const trimFrac = policy.tpTrimPct ?? (policy.style === 'wealth' ? 0.3 : 0.5);
  const hitTp = recKind === 'trim' || r >= (policy.tpTrimR || 3);
  if (hitTp) {
    const cut = Math.max(Number((qty * trimFrac).toFixed(4)), 0);
    if (cut > 0 && cut + 1e-9 < qty) {
      return { action: 'TRIM', reason: recKind === 'trim' ? 'rec-tp' : 'tp', qty: cut, trail: trailStop(pos, last, policy) };
    }
    if (cut >= qty) return { action: 'SELL', reason: 'tp', qty, trail: null };
  }
  const trail = trailStop(pos, last, policy);
  if (trail != null && stop != null && trail > stop + 1e-6) {
    return { action: 'HOLD', reason: 'trail', qty: 0, trail };
  }
  return { action: 'HOLD', reason: 'hold', qty: 0, trail: null };
}
