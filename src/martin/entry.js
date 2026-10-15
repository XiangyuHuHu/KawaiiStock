import { emaSeries } from '../levels.js';
import { closedBars } from '../market-time.js';
import { classifyEmaStack as stackStages } from './classify.js';

export { classifyEmaStack } from './classify.js';

function roundPx(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100) / 100;
}

export function usableBars(bars, now) {
  const list = (bars || []).filter((bar) => bar && bar.close > 0 && bar.high > 0 && bar.low > 0);
  if (!list.length) return [];
  if (!now || list.some((bar) => !bar.date)) return list;
  return closedBars(list, now);
}

/** ADR20% = 近 20 根 (High-Low)/Low 的平均。不是 ATR，也不拿来填 Volatility 1W【M1】【A】。 */
export function adr20Pct(bars) {
  const window = (bars || []).slice(-20);
  if (window.length < 20) return null;
  let sum = 0;
  for (const bar of window) {
    if (!(bar.low > 0) || !(bar.high >= bar.low)) return null;
    sum += ((bar.high - bar.low) / bar.low) * 100;
  }
  return sum / window.length;
}

/**
 * 止损距离相对 ½ ADR 的软检查。
 * 不通过时保持原 planned_stop，不放宽、也不改紧来凑条件【M1】【A】。
 */
export function adrStopSoftCheck({ entry, plannedStop, adrPct }) {
  const halfAdrPct = adrPct == null ? null : adrPct / 2;
  if (!(entry > 0) || !(plannedStop > 0) || !(entry > plannedStop)) {
    return {
      pass: null,
      soft: true,
      ideal: 'stop_distance_lte_half_adr',
      stopDistancePct: null,
      halfAdrPct,
      adr20Pct: adrPct ?? null,
      widened: false,
      tightened: false,
      note: '没有同时有效的参考入场和 planned_stop，软检查留空。'
    };
  }
  const stopDistancePct = ((entry - plannedStop) / entry) * 100;
  const pass = halfAdrPct == null ? null : stopDistancePct <= halfAdrPct + 1e-9;
  return {
    pass,
    soft: true,
    ideal: 'stop_distance_lte_half_adr',
    stopDistancePct,
    halfAdrPct,
    adr20Pct: adrPct ?? null,
    widened: false,
    tightened: false,
    note: pass === false
      ? '止损距离大于约 ½ ADR。放弃这笔参考，不放宽止损凑仓【M1】【A】。'
      : '止损距离相对 ADR 只做软检查，待回测【M1】【A】。'
  };
}

function breakoutIndexes(bars, ema21s) {
  const found = [];
  for (let i = 20; i < bars.length; i += 1) {
    let priorHigh = -Infinity;
    for (let j = i - 20; j < i; j += 1) priorHigh = Math.max(priorHigh, bars[j].high);
    if (bars[i].high > priorHigh && bars[i].close > ema21s[i]) found.push(i);
  }
  return found;
}

/**
 * 突破后的第一次健康回踩【I1】【A，待回测】。
 * planned_stop 是回踩低点：跌破它，这笔结构失效。延伸中的突破只观察，不追。
 * Lag 排列里的反弹记成抄底，不是健康回踩。
 */
export function assessStructure(bars) {
  const list = bars || [];
  const closes = list.map((bar) => bar.close);
  const ema9s = closes.length >= 9 ? emaSeries(closes, 9) : [];
  const ema21s = closes.length >= 21 ? emaSeries(closes, 21) : [];
  const ema23s = closes.length >= 23 ? emaSeries(closes, 23) : [];
  const ema50s = closes.length >= 50 ? emaSeries(closes, 50) : [];
  const ema9 = ema9s.at(-1) ?? null;
  const ema21 = ema21s.at(-1) ?? null;
  const ema23 = ema23s.at(-1) ?? null;
  const ema50 = ema50s.at(-1) ?? null;
  const stacked = stackStages(ema9, ema21, ema50);
  const last = list.length ? list[list.length - 1].close : null;
  const base = {
    stage: stacked.stage,
    stageReason: stacked.reason,
    ema9,
    ema21,
    ema23,
    ema50,
    last,
    adr20Pct: adr20Pct(list),
    setup: 'NO_SETUP',
    planned_stop: null,
    referenceEntry: last,
    breakoutDate: null,
    note: stacked.reason
  };
  if (list.length < 50 || !(ema21 > 0) || !(ema50 > 0)) {
    return { ...base, note: '日线不足 50 根，不编造结构失效位。' };
  }
  const breakouts = breakoutIndexes(list, ema21s);
  if (!breakouts.length) return { ...base, note: '近端没有站上 21EMA 的 20 日新高，没有突破结构。' };
  const latest = breakouts[breakouts.length - 1];
  if (latest === list.length - 1) {
    const low = list[latest].low;
    return {
      ...base,
      setup: 'BREAKOUT_EXTENDED',
      planned_stop: low < last ? roundPx(low) : null,
      breakoutDate: list[latest].date || null,
      note: '刚创阶段高点，还没有第一次回踩。偏好等回踩，不追【I1】【A】。'
    };
  }
  const leg = list.slice(latest + 1);
  const pullbackLow = Math.min(...leg.map((bar) => bar.low));
  const dipped = pullbackLow < list[latest].close;
  const above21 = last > ema21;
  const above50 = last > ema50;
  const hold50 = pullbackLow > ema50;
  if (stacked.stage === 'LAG') {
    return {
      ...base,
      setup: 'LAGGING_BOUNCE',
      planned_stop: pullbackLow < last ? roundPx(pullbackLow) : null,
      breakoutDate: list[latest].date || null,
      note: '9/21/50 空头排列里的反弹不是强势股第一次健康回踩【I1】【A】。'
    };
  }
  if (dipped && above21 && above50 && hold50) {
    return {
      ...base,
      setup: 'FIRST_PULLBACK',
      planned_stop: roundPx(pullbackLow),
      breakoutDate: list[latest].date || null,
      note: '突破后的第一次回踩。planned_stop 放在回踩低点，跌破即结构失效【I1】【A】。'
    };
  }
  return {
    ...base,
    setup: 'NO_SETUP',
    planned_stop: pullbackLow < last ? roundPx(pullbackLow) : null,
    breakoutDate: list[latest].date || null,
    note: '有过高点，但回踩不健康，或已经失守 21/50EMA【A】。'
  };
}

/** SPY 与 QQQ 同时站上 21/50 才是 RISK_ON。这是工程提示【A】，不是 Martin 的原阈值。 */
export function marketRegimeHint(spyBars, qqqBars) {
  const side = (bars) => {
    const list = bars || [];
    if (list.length < 50) return null;
    const closes = list.map((bar) => bar.close);
    const close = closes[closes.length - 1];
    const ema21 = emaSeries(closes, 21).at(-1);
    const ema50 = emaSeries(closes, 50).at(-1);
    if (!(close > 0) || !(ema21 > 0) || !(ema50 > 0)) return null;
    return {
      up: close > ema21 && ema21 > ema50,
      down: close < ema21 && close < ema50
    };
  };
  const spy = side(spyBars);
  const qqq = side(qqqBars);
  const base = { source: 'A', label: '待回测', pendingBacktest: true };
  if (!spy || !qqq) {
    return {
      ...base,
      hint: 'UNKNOWN',
      notes: ['SPY 或 QQQ 日线不足，市场状态留空，不给新的买入参考【A】。']
    };
  }
  if (spy.up && qqq.up) {
    return { ...base, hint: 'RISK_ON', notes: ['SPY 与 QQQ 收盘在上行的 21/50EMA 之上。研究默认，待回测【A】。'] };
  }
  if (spy.down && qqq.down) {
    return { ...base, hint: 'RISK_OFF', notes: ['SPY 与 QQQ 同时跌破 21EMA 和 50EMA。不主动给新多参考【A】。'] };
  }
  return { ...base, hint: 'NEUTRAL', notes: ['指数分化或震荡。只把极清晰的首次回踩留作参考，单笔风险仍以现有闸门为准【A】。'] };
}
