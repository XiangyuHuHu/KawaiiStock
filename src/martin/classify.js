/** 9/21/50 EMA 只做强度分类，不是买卖按钮【M1】。 */

export function classifyEmaStack(ema9, ema21, ema50) {
  if (!(ema9 > 0) || !(ema21 > 0) || !(ema50 > 0)) {
    return { stage: 'TRANSITION', reason: '均线不足，不能分成 Lead / Mediocre / Lag。' };
  }
  if (ema9 > ema21 && ema21 > ema50) {
    return { stage: 'LEAD', reason: 'EMA9 > EMA21 > EMA50，强度分类 Lead【M1】。' };
  }
  if (ema9 < ema21 && ema21 < ema50) {
    return { stage: 'LAG', reason: 'EMA9 < EMA21 < EMA50，强度分类 Lag【M1】。' };
  }
  if ((ema9 > ema21 && ema21 < ema50) || (ema9 < ema21 && ema21 > ema50)) {
    return { stage: 'MEDIOCRE', reason: '9/21/50 均线交错，强度分类 Mediocre【M1】。' };
  }
  return { stage: 'TRANSITION', reason: '均线打平或未形成明确排列，记为过渡【A】。' };
}
