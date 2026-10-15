import { adxValue, atrValue, emaSeries, structureOf, trueRange } from './indicators.js';

/** 研究默认。没有回测结论，不代表这组阈值能赚钱。 */
export const QUANT_PARAMS = {
  label: 'research-defaults',
  liveTradingAuthority: false,
  pendingBacktest: true,
  adxStrong: 22,
  adxDown: 18,
  shockTrMultiple: 2.5,
  shockAtrRatio: 1.6,
  shockRangeMultiple: 1.5,
  extensionExhaustAtr: 3,
  extensionIgnitionAtr: 1.2,
  ignitionAdxBelow: 32,
  givebackWatchPct: 25,
  highVolK: [2.5, 3, 3.5, 4]
};

export const PLAYBOOK = {
  StrongTrend: 'trend-follow',
  Range: 'mean-revert',
  DownTrend: 'defend',
  HighVolEvent: 'defend',
  unknown: 'defend'
};

export function featuresFromBars(bars) {
  const list = bars || [];
  const closes = list.map((bar) => bar.close).filter((value) => value > 0);
  const last = closes.length ? closes[closes.length - 1] : null;
  const ema20Series = closes.length >= 20 ? emaSeries(closes, 20) : [];
  const ema50Series = closes.length >= 50 ? emaSeries(closes, 50) : [];
  const ema200Series = closes.length >= 200 ? emaSeries(closes, 200) : [];
  const ema20 = ema20Series.length ? ema20Series[ema20Series.length - 1] : null;
  const prevEma20 = ema20Series.length > 1 ? ema20Series[ema20Series.length - 2] : null;
  const ema50 = ema50Series.length ? ema50Series[ema50Series.length - 1] : null;
  const ema200 = ema200Series.length ? ema200Series[ema200Series.length - 1] : null;
  const atr14 = atrValue(list, 14);
  const adx14 = adxValue(list, 14);
  const structure = structureOf(list);
  const lastTrueRange = trueRange(list);
  const longer = list.length > 30 ? atrValue(list.slice(0, -14), 14) : null;
  const atrRatio = atr14 > 0 && longer > 0 ? atr14 / longer : null;
  const prev = list.length > 1 ? list[list.length - 2] : null;
  const structureBreak = Boolean(
    ema20 && ema50 && ema20 > ema50 && prev && prevEma20 && prev.close > prevEma20 && last < ema20
  );
  const extension = atr14 > 0 && ema20 != null && last != null ? (last - ema20) / atr14 : null;
  return {
    close: last,
    ema20,
    ema50,
    ema200,
    adx14,
    atr14,
    lastTrueRange,
    atrRatio,
    extension,
    structureBreak,
    ...structure
  };
}

export function classifyRegime(features = {}) {
  const {
    close, ema20, ema50, ema200, adx14, atr14, lastTrueRange, atrRatio,
    rising20, falling20, high20, low20
  } = features;
  const shock = atr14 > 0 && lastTrueRange >= QUANT_PARAMS.shockTrMultiple * atr14;
  const expanding = atrRatio >= QUANT_PARAMS.shockAtrRatio
    && atr14 > 0
    && lastTrueRange >= QUANT_PARAMS.shockRangeMultiple * atr14;
  if (shock || expanding) {
    return { regime: 'HighVolEvent', playbook: PLAYBOOK.HighVolEvent, regimeReason: shock ? 'range-shock' : 'atr-expansion' };
  }
  if (!(close > 0) || !(ema20 > 0) || !(ema50 > 0) || adx14 == null || !(atr14 > 0)) {
    return { regime: 'unknown', playbook: PLAYBOOK.unknown, regimeReason: 'indicators-short' };
  }
  const stackedUp = close > ema20 && ema20 > ema50 && (ema200 == null || ema50 > ema200);
  const nearHigh = high20 > 0 && close >= high20 * 0.97;
  if (stackedUp && adx14 >= QUANT_PARAMS.adxStrong && (rising20 || nearHigh)) {
    return { regime: 'StrongTrend', playbook: PLAYBOOK.StrongTrend, regimeReason: rising20 ? 'ema-adx-structure' : 'ema-adx-near-high' };
  }
  const stackedDown = close < ema20 && ema20 < ema50 && (ema200 == null || ema50 < ema200);
  const nearLow = low20 > 0 && close <= low20 * 1.03;
  if (stackedDown && adx14 >= QUANT_PARAMS.adxDown && (falling20 || nearLow)) {
    return { regime: 'DownTrend', playbook: PLAYBOOK.DownTrend, regimeReason: falling20 ? 'ema-adx-structure' : 'ema-adx-near-low' };
  }
  return { regime: 'Range', playbook: PLAYBOOK.Range, regimeReason: 'no-trend-stack' };
}

export function classifyStage(features = {}, regime = 'unknown') {
  if (regime === 'unknown') {
    return { stage: null, exhausted: false, scores: { trend: null, exhaustion: null } };
  }
  const { extension, adx14, structureBreak, rising60 } = features;
  const exhaustionScore = (() => {
    let score = 0;
    if (extension != null && extension >= QUANT_PARAMS.extensionExhaustAtr) score += 70;
    else if (extension != null && extension >= 2.2) score += 28;
    if (structureBreak) score += 45;
    return Math.max(0, Math.min(100, score));
  })();
  let trend = 15;
  if (features.close > features.ema20) trend += 20;
  if (features.ema20 > features.ema50) trend += 20;
  if (features.ema200 == null || features.ema50 > features.ema200) trend += 10;
  if (adx14 >= QUANT_PARAMS.adxStrong) trend += 20;
  else if (adx14 >= QUANT_PARAMS.adxDown) trend += 8;
  if (regime === 'StrongTrend') trend += 15;
  if (regime === 'DownTrend') trend -= 35;
  trend = Math.max(0, Math.min(100, trend));
  const exhausted = exhaustionScore >= 45 || structureBreak === true || (extension != null && extension >= QUANT_PARAMS.extensionExhaustAtr);
  let stage = null;
  if (regime === 'DownTrend' || regime === 'HighVolEvent') stage = '防守';
  else if (regime === 'unknown') stage = null;
  else if (exhausted) stage = '衰竭';
  else if (
    regime === 'StrongTrend'
    && extension != null
    && extension < QUANT_PARAMS.extensionIgnitionAtr
    && adx14 < QUANT_PARAMS.ignitionAdxBelow
    && !rising60
  ) stage = '启动';
  else if (regime === 'StrongTrend') stage = '主升';
  else stage = '震荡';
  return {
    stage,
    exhausted,
    scores: {
      trend,
      exhaustion: regime === 'unknown' ? null : exhaustionScore
    }
  };
}
