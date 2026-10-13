import { emaSeries, atrValue } from '../levels.js';

export const STRATEGY_VERSION = 'cycle-v2-confirmed-20260911';
export const RESEARCH_RULES = Object.freeze({ riskFraction: 0.005, positionFraction: 0.10, maxPositions: 5, maxPortfolioRisk: 0.025, maxHoldBars: 10, targetR: 2, slippageBps: 5 });
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Fixed, interpretable rules. Score is a ranking heuristic, not a probability. */
export function confirmCycle(bars, legacy) {
  const reasons = [];
  const out = { ...legacy, version: STRATEGY_VERSION, experimental: true, legacyScore: legacy.score, legacyAllowNewLong: legacy.allowNewLong, allowNewLong: false, sizeR: 0 };
  if (!legacy.ok || bars.length < 60) return { ...out, confirmation: { confirmed: false, reasons: ['完整日线不足 60 根'] }, note: 'V2 待确认：完整日线不足' };
  const prior = bars.slice(0, -1);
  const bar = bars.at(-1), prev = prior.at(-1);
  const closes = bars.map((row) => row.close);
  const ema20 = emaSeries(closes, 20), ema50 = emaSeries(closes, 50);
  const atr = atrValue(prior, 14);
  const avgVolume = mean(prior.slice(-20).map((row) => row.volume || 0));
  const volumeRatio = avgVolume > 0 ? bar.volume / avgVolume : null;
  const dollarVolume = mean(prior.slice(-20).map((row) => row.close * (row.volume || 0)));
  const high = Math.max(...prior.slice(-20).map((row) => row.high));
  const low = Math.min(...prior.slice(-20).map((row) => row.low));
  const tight = (high - low) / low <= 0.16;
  const recentRange = mean(prior.slice(-10).map((row) => row.high - row.low));
  const olderRange = mean(prior.slice(-30, -10).map((row) => row.high - row.low));
  const breakout = bar.close > high && prev.close <= high && (tight || recentRange < olderRange * 0.8) && volumeRatio >= 1.3;
  const pullback = atr > 0 && prev.low >= ema20.at(-2) - atr && prev.low <= ema20.at(-2) + atr * 0.3
    && prev.close <= ema20.at(-2) + atr * 0.5 && bar.close > prev.high && bar.close > bar.open && volumeRatio >= 1;
  if (legacy.regime !== 'risk-on') reasons.push('大盘不是 Risk On');
  if (!(bar.close > ema20.at(-1) && ema20.at(-1) > ema50.at(-1) && ema20.at(-1) > ema20.at(-6) && ema50.at(-1) > ema50.at(-6))) reasons.push('趋势未同步向上');
  if (!(legacy.rs20 > 0)) reasons.push('未跑赢 QQQ');
  if (!(dollarVolume >= 20_000_000 && bar.close >= 5)) reasons.push('价格或成交额不足');
  if (!(atr > 0) || (bar.close - ema20.at(-1)) / atr > 2) reasons.push('波动数据缺失或已过度延伸');
  if (!breakout && !pullback) reasons.push('没有新突破 / 回踩收复确认');
  const stop = atr > 0 ? Math.min(bar.close - atr, Math.max(bar.close - 2 * atr, Math.min(bar.low, prev.low) - atr * 0.15)) : null;
  const stopPct = stop > 0 ? (bar.close - stop) / bar.close : null;
  if (!(stopPct >= 0.015 && stopPct <= 0.10)) reasons.push('止损距离不在 1.5%–10%');
  const score = Math.max(0, legacy.score - (legacy.scores?.catalyst || 0));
  if (!(score >= 80)) reasons.push(`分数 ${score} 低于 80`);
  const confirmed = reasons.length === 0;
  const stage = breakout ? (tight ? 'base-n-break' : 'wedge-pop') : pullback ? 'ema-crossback' : legacy.stage;
  const labels = { 'base-n-break': "Base 'n Break", 'wedge-pop': 'Wedge Pop', 'ema-crossback': 'EMA Crossback' };
  const stageNo = { 'base-n-break': 4, 'wedge-pop': 2, 'ema-crossback': 3 };
  return { ...out, score, scores: { ...legacy.scores, catalyst: 0 }, stage, stageLabel: labels[stage] || legacy.stageLabel, stageNo: stageNo[stage] || legacy.stageNo,
    signalDate: bar.date, last: bar.close, stop, atr, atrPct: atr / bar.close * 100, volumeRatio,
    allowNewLong: confirmed, watch: !confirmed && legacy.tradeable, tradeable: confirmed || legacy.tradeable, sizeR: confirmed ? 1 : 0,
    confirmation: { confirmed, reasons, setup: breakout ? 'breakout' : pullback ? 'pullback-reclaim' : null, referenceHigh: high, dollarVolume },
    riskPlan: { ...RESEARCH_RULES, stop, target: stop > 0 ? bar.close + (bar.close - stop) * 2 : null },
    note: `V2 实验 · ${confirmed ? '收盘确认，次日限价候选' : reasons.join('；')} · 分数不是胜率`
  };
}

export function sizeConfirmed({ nav, cash, price, stop, currentRisk = 0, currentNotional = 0 }) {
  if (![nav, cash, price, stop, currentRisk, currentNotional].every(Number.isFinite) || !(nav > 0 && cash >= 0 && price > stop && stop > 0)) return null;
  const riskBudget = Math.max(0, Math.min(nav * RESEARCH_RULES.riskFraction, nav * RESEARCH_RULES.maxPortfolioRisk - currentRisk));
  const notionalBudget = Math.max(0, Math.min(cash, nav * RESEARCH_RULES.positionFraction - currentNotional));
  const qty = Math.floor(Math.min(riskBudget / (price - stop), notionalBudget / price));
  return qty > 0 ? { qty, maxLoss: qty * (price - stop), notional: qty * price } : null;
}
