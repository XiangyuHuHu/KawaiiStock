import { loadHistoricals, loadManyHistoricals } from '../historicals.js';
import { atrValue, emaSeries } from '../levels.js';
import { confirmCycle, STRATEGY_VERSION } from './confirmation.js';
import { closedBars } from '../market-time.js';

export const CYCLE_ID = 'cycle-of-price-action';
export const CYCLE_NAME = 'Cycle of Price Action';
export const BENCHMARK = 'QQQ';

export const STAGES = {
  REVERSAL: { id: 'reversal-extension', no: 1, label: 'Reversal Extension', tradeable: false, sizeR: 0 },
  WEDGE_POP: { id: 'wedge-pop', no: 2, label: 'Wedge Pop', tradeable: true, sizeR: 1 },
  CROSSBACK: { id: 'ema-crossback', no: 3, label: 'EMA Crossback', tradeable: true, sizeR: 1.25 },
  BASE: { id: 'base-n-break', no: 4, label: "Base 'n Break", tradeable: true, sizeR: 1.25 },
  EXHAUSTION: { id: 'exhaustion-extension', no: 5, label: 'Exhaustion Extension', tradeable: false, sizeR: 0 },
  DROP: { id: 'wedge-drop', no: 6, label: 'Wedge Drop', tradeable: false, sizeR: 0 },
  UNKNOWN: { id: 'unknown', no: 0, label: 'DATA UNAVAILABLE', tradeable: false, sizeR: 0 }
};

const TRADEABLE = new Set([STAGES.WEDGE_POP.id, STAGES.CROSSBACK.id, STAGES.BASE.id]);

export const STAGE_LIST = Object.values(STAGES).sort((a, b) => a.no - b.no);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function last(arr) {
  return arr?.length ? arr[arr.length - 1] : null;
}

function mean(values) {
  const xs = values.filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function pctRet(bars, n) {
  if (!bars?.length || bars.length <= n) return null;
  const a = bars[bars.length - 1].close;
  const b = bars[bars.length - 1 - n].close;
  if (!(a > 0) || !(b > 0)) return null;
  return (a / b - 1) * 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function roundPx(n, lastPx) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const x = Number(n);
  const ref = lastPx ?? x;
  if (ref >= 10) return Math.round(x * 100) / 100;
  return Math.round(x * 1000) / 1000;
}

function windowOf(bars, n) {
  return bars.slice(-n);
}

function rangeOf(bars) {
  if (!bars.length) return { high: null, low: null, width: null };
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const mid = (high + low) / 2;
  return { high, low, width: mid > 0 ? (high - low) / mid : null };
}

function volAvg(bars, n = 20) {
  const win = windowOf(bars, n);
  return mean(win.map((b) => b.volume || 0));
}

function contraction(bars) {
  const recent = bars.slice(-15);
  const prior = bars.slice(-40, -15);
  if (recent.length < 10 || prior.length < 12) return { ok: false };
  const recentR = rangeOf(recent);
  const priorR = rangeOf(prior);
  const recentAtr = mean(recent.map((b) => b.high - b.low));
  const priorAtr = mean(prior.map((b) => b.high - b.low));
  const ratio = priorAtr > 0 ? recentAtr / priorAtr : null;
  const contracting = ratio != null && ratio < 0.75 && recentR.width != null && priorR.width != null && recentR.width < priorR.width * 0.8;
  return {
    ok: true,
    contracting,
    ratio,
    recentHigh: recentR.high,
    recentLow: recentR.low,
    recentWidth: recentR.width
  };
}

function findBase(bars) {
  const win = bars.slice(-30);
  if (win.length < 16) return null;
  const box = rangeOf(win);
  const prior = bars.slice(-80, -30);
  const priorUp = prior.length >= 20 && prior[prior.length - 1].close > prior[0].close * 1.08;
  const tight = box.width != null && box.width < 0.16;
  const volDry = (() => {
    const baseVol = mean(win.map((b) => b.volume || 0));
    const priorVol = mean(prior.slice(-20).map((b) => b.volume || 0));
    return priorVol > 0 && baseVol != null && baseVol < priorVol * 0.85;
  })();
  return { ...box, priorUp, tight, volDry };
}

function brokeOut(bars, level, lookback = 3) {
  if (!(level > 0)) return false;
  const recent = bars.slice(-lookback);
  return recent.some((b) => b.close >= level * 0.998 && b.high >= level);
}

function brokeDown(bars, level, lookback = 3) {
  if (!(level > 0)) return false;
  const recent = bars.slice(-lookback);
  return recent.some((b) => b.close <= level * 1.002 && b.low <= level);
}

function nearEma(low, close, ema, atr) {
  if (!(ema > 0)) return false;
  const band = Math.max(ema * 0.012, (atr || ema * 0.02) * 0.7);
  return low <= ema + band && close >= ema - band * 0.25;
}

function failedBreakout(bars, high) {
  if (!(high > 0) || bars.length < 8) return false;
  const older = bars.slice(-12, -2);
  const last2 = bars.slice(-2);
  const poked = older.some((b) => b.high >= high);
  const rolled = last2.every((b) => b.close < high * 0.99) && last(last2).close < last(last2).open;
  return poked && rolled;
}

function scoreStages(ctx) {
  const {
    lastPx, ema10, ema20, ema50, ema200, atr, ret10, ret20, ret5,
    volRatio, wedge, base, uptrend, downtrend
  } = ctx;
  const scores = {
    [STAGES.REVERSAL.id]: 0,
    [STAGES.WEDGE_POP.id]: 0,
    [STAGES.CROSSBACK.id]: 0,
    [STAGES.BASE.id]: 0,
    [STAGES.EXHAUSTION.id]: 0,
    [STAGES.DROP.id]: 0
  };

  const extAtr = atr > 0 ? (lastPx - ema20) / atr : 0;
  if (extAtr >= 2.4 && ret10 != null && ret10 >= 16) scores[STAGES.EXHAUSTION.id] += 40;
  if (extAtr >= 3 && volRatio >= 1.8) scores[STAGES.EXHAUSTION.id] += 25;
  if (ret5 != null && ret5 >= 12 && volRatio >= 2) scores[STAGES.EXHAUSTION.id] += 20;
  if (uptrend && extAtr >= 2) scores[STAGES.EXHAUSTION.id] += 10;

  if (wedge.ok && wedge.contracting && brokeOut(ctx.bars, wedge.recentHigh) && lastPx > ema20) {
    scores[STAGES.WEDGE_POP.id] += 45;
    if (volRatio >= 1.5) scores[STAGES.WEDGE_POP.id] += 25;
    else if (volRatio >= 1.2) scores[STAGES.WEDGE_POP.id] += 12;
    if (uptrend) scores[STAGES.WEDGE_POP.id] += 10;
  }

  if (uptrend && !downtrend && (nearEma(ctx.low5, lastPx, ema10, atr) || nearEma(ctx.low5, lastPx, ema20, atr))) {
    scores[STAGES.CROSSBACK.id] += 42;
    if (lastPx > ema20) scores[STAGES.CROSSBACK.id] += 15;
    if (ret20 != null && ret20 > 0) scores[STAGES.CROSSBACK.id] += 12;
    if (extAtr < 1.6) scores[STAGES.CROSSBACK.id] += 10;
  }

  if (base?.tight && base.priorUp) {
    scores[STAGES.BASE.id] += 36;
    if (brokeOut(ctx.bars, base.high) || lastPx >= base.high * 0.99) scores[STAGES.BASE.id] += 22;
    else if (base.width != null && lastPx >= base.low + (base.high - base.low) * 0.7) scores[STAGES.BASE.id] += 10;
    if (base.volDry) scores[STAGES.BASE.id] += 12;
    if (uptrend) scores[STAGES.BASE.id] += 8;
  }

  if (wedge.ok && (brokeDown(ctx.bars, wedge.recentLow) || failedBreakout(ctx.bars, wedge.recentHigh))) {
    scores[STAGES.DROP.id] += 40;
  }
  if (downtrend && lastPx < ema20 && ema20 < ema50) scores[STAGES.DROP.id] += 25;
  if (ret20 != null && ret20 <= -10 && lastPx < ema50) scores[STAGES.DROP.id] += 15;
  if (ctx.low5 <= (ctx.low20 || ctx.low5) * 1.002 && downtrend) scores[STAGES.DROP.id] += 10;
  // A failed poke while price is still above EMA50 is not a wedge drop.
  if (lastPx > ema50) scores[STAGES.DROP.id] = 0;

  if (!uptrend && (lastPx < ema50 || (ema200 && lastPx < ema200))) {
    if (ret20 != null && ret20 <= -12) scores[STAGES.REVERSAL.id] += 20;
    if (ctx.low20 && lastPx > ctx.low20 * 1.03 && ret5 != null && ret5 > 0) scores[STAGES.REVERSAL.id] += 28;
    if (extAtr <= -2) scores[STAGES.REVERSAL.id] += 15;
  }

  let best = STAGES.UNKNOWN;
  let bestScore = 18;
  for (const spec of Object.values(STAGES)) {
    if (!spec.no) continue;
    const s = scores[spec.id] || 0;
    if (s > bestScore) {
      bestScore = s;
      best = spec;
    }
  }
  if (best.id === STAGES.UNKNOWN.id && uptrend) {
    best = extAtr >= 2.2 ? STAGES.EXHAUSTION : (nearEma(ctx.low5, lastPx, ema20, atr) ? STAGES.CROSSBACK : STAGES.BASE);
    bestScore = 22;
  } else if (best.id === STAGES.UNKNOWN.id && downtrend) {
    best = STAGES.DROP;
    bestScore = 22;
  } else if (best.id === STAGES.UNKNOWN.id) {
    best = STAGES.REVERSAL;
    bestScore = 20;
  }
  return { stage: best, confidence: clamp(bestScore / 80, 0.2, 1), stageScores: scores };
}

function regimeOf(qqqBars) {
  if (!qqqBars?.length || qqqBars.length < 50) {
    return { id: 'unknown', label: 'DATA UNAVAILABLE', score: 0 };
  }
  const closes = qqqBars.map((b) => b.close);
  const lastPx = last(closes);
  const e20 = last(emaSeries(closes, 20));
  const e50 = last(emaSeries(closes, 50));
  const e200 = last(emaSeries(closes, Math.min(200, closes.length)));
  if (lastPx > e20 && e20 > e50 && e50 > e200) return { id: 'risk-on', label: 'Risk On', score: 10 };
  if (lastPx < e20 && e20 < e50) return { id: 'risk-off', label: 'Risk Off', score: 0 };
  return { id: 'neutral', label: 'Neutral', score: 5 };
}

function catalystScore(meta = {}) {
  const buckets = meta.buckets || [];
  const lists = `${(meta.lists || []).join(' ')}`;
  if (/催化|事件|财报/.test(lists)) return { score: 8, note: '清单含事件/催化（弱代理，不是新闻）' };
  if (buckets.includes('highBeta')) return { score: 6, note: '高Beta 清单（弱代理）' };
  if (buckets.includes('tactical')) return { score: 5, note: '战术清单（弱代理）' };
  if (buckets.includes('primary')) return { score: 4, note: '严选清单（弱代理）' };
  return { score: 0, note: 'DATA UNAVAILABLE：无独立催化数据' };
}

function componentScores({ lastPx, ema20, ema50, ema200, ret20, rs20, rs5, volRatio, stage, regime, catalyst, stop, atr, wedge, base }) {
  let trend = 4;
  if (lastPx > ema20) trend += 6;
  if (ema20 > ema50) trend += 5;
  if (ema200 && ema50 > ema200) trend += 3;
  if (ret20 != null && ret20 > 0) trend += 2;
  trend = clamp(trend, 0, 20);

  let rs = 4;
  if (rs20 == null) rs = 0;
  else if (rs20 >= 8) rs = 18;
  else if (rs20 >= 3) rs = 15;
  else if (rs20 >= 0) rs = 12;
  else if (rs20 >= -3) rs = 6;
  else rs = 2;
  if (rs20 != null && rs5 != null && rs5 > 0) rs = clamp(rs + 2, 0, 20);

  let volume = 4;
  if (volRatio == null) volume = 0;
  else if (stage.id === STAGES.WEDGE_POP.id && volRatio >= 2) volume = 15;
  else if (stage.id === STAGES.WEDGE_POP.id && volRatio >= 1.5) volume = 13;
  else if (base?.volDry) volume = 11;
  else if (wedge?.contracting && volRatio < 0.9) volume = 10;
  else if (volRatio >= 1.5) volume = 9;
  else if (volRatio >= 1) volume = 6;

  let structure = 6;
  if (stage.id === STAGES.CROSSBACK.id) structure = 18;
  else if (stage.id === STAGES.BASE.id) structure = 17;
  else if (stage.id === STAGES.WEDGE_POP.id) structure = volRatio >= 1.5 ? 18 : 14;
  else if (stage.id === STAGES.REVERSAL.id) structure = 8;
  else if (stage.id === STAGES.EXHAUSTION.id) structure = 4;
  else if (stage.id === STAGES.DROP.id) structure = 1;

  let rr = 0;
  if (stop != null && lastPx > stop) {
    const riskPct = (lastPx - stop) / lastPx;
    if (riskPct >= 0.03 && riskPct <= 0.1) rr = 5;
    else if (riskPct >= 0.02 && riskPct <= 0.14) rr = 3;
    else rr = 1;
  }

  return {
    trend,
    rs,
    volume,
    structure,
    regime: regime.score,
    catalyst: catalyst.score,
    rr
  };
}

function stopFor(stage, { lastPx, atr, ema20, wedge, base, low5 }) {
  const cushion = Math.max((atr || lastPx * 0.02) * 0.35, lastPx * 0.008);
  if (stage.id === STAGES.WEDGE_POP.id && wedge?.recentLow) {
    return roundPx(Math.min(wedge.recentLow - cushion, lastPx * 0.97), lastPx);
  }
  if (stage.id === STAGES.CROSSBACK.id) {
    const emaStop = ema20 > 0 ? ema20 * 0.985 : lastPx * 0.96;
    const swing = low5 != null ? low5 - cushion : emaStop;
    return roundPx(Math.min(emaStop, swing, lastPx * 0.97), lastPx);
  }
  if (stage.id === STAGES.BASE.id && base?.low) {
    return roundPx(Math.min(base.low - cushion, lastPx * 0.96), lastPx);
  }
  if (stage.id === STAGES.REVERSAL.id) return roundPx(lastPx * 0.92, lastPx);
  return roundPx(lastPx * 0.95, lastPx);
}

export function gateCrossbackBreak(result, bars) {
  if (!result || result.stage !== STAGES.CROSSBACK.id) return result;
  const clean = (bars || []).filter((bar) => bar && bar.close > 0);
  const lastPx = Number(result.last);
  const prev = clean.length >= 2 ? clean[clean.length - 2].close : null;
  const atr = Number(result.atr);
  const ema10 = Number(result.ema10);
  const drop = prev > 0 && lastPx > 0 ? prev - lastPx : 0;
  const broke = (atr > 0 && drop > 1.5 * atr) || (ema10 > 0 && lastPx < ema10);
  if (!broke) return result;
  return {
    ...result,
    allowNewLong: false,
    watch: false,
    tradeable: false,
    sizeR: 0,
    pendingConfirm: true,
    pendingConfirmLabel: '今日跌破，待确认',
    note: `${result.note || result.stageLabel || 'EMA Crossback'} · 今日跌破，待确认`
  };
}

export function classifyBars(bars, options = {}) {
  const clean = bars || [];
  if (options.version === 'v1') return gateCrossbackBreak(classifyBarsV1(clean, options), clean);
  // V2 is a completed daily-bar signal; a live quote must not rewrite its indicators.
  const legacy = classifyBarsV1(clean, { ...options, lastOverride: undefined });
  const confirmed = confirmCycle(clean, legacy, { spot: options.lastOverride });
  return gateCrossbackBreak(confirmed, clean);
}

export function primaryBlockReason(cycle) {
  if (!cycle) return '没有周期扫描';
  if (cycle.pendingConfirm) return cycle.pendingConfirmLabel || '今日跌破，待确认';
  const reasons = cycle.confirmation?.reasons;
  if (cycle.confirmation && cycle.confirmation.confirmed === false && reasons?.length) return reasons[0];
  if (cycle.ok && cycle.allowNewLong !== true) {
    if (!TRADEABLE.has(cycle.stage)) return `${cycle.stageLabel || cycle.stage} 不是可开形态`;
    if (!(Number(cycle.score) >= 80)) return `分数 ${cycle.score ?? '—'} 低于 80`;
    return '收盘确认未通过';
  }
  return null;
}

export function classifyBarsV1(bars, { qqqBars = [], meta = {}, lastOverride } = {}) {
  const clean = (bars || []).filter((b) => b && b.close > 0 && b.high > 0 && b.low > 0);
  if (!clean.length || clean.length < 50) {
    return unavailable('日线不足 50 根');
  }
  bars = clean;
  const closes = bars.map((b) => b.close);
  const lastPx = (lastOverride > 0 ? lastOverride : last(closes));
  if (!(lastPx > 0)) return unavailable('现价无效');
  const ema10 = last(emaSeries(closes, 10));
  const ema20 = last(emaSeries(closes, 20));
  const ema50 = last(emaSeries(closes, 50));
  const ema200 = closes.length >= 120 ? last(emaSeries(closes, Math.min(200, closes.length))) : null;
  const atr = atrValue(bars, 14) || lastPx * 0.025;
  const ret5 = pctRet(bars, 5);
  const ret10 = pctRet(bars, 10);
  const ret20 = pctRet(bars, 20);
  const qqq20 = pctRet(qqqBars, 20);
  const qqq5 = pctRet(qqqBars, 5);
  const rs20 = ret20 != null && qqq20 != null ? ret20 - qqq20 : null;
  const rs5 = ret5 != null && qqq5 != null ? ret5 - qqq5 : null;
  const avgVol = volAvg(bars, 20);
  const lastVol = last(bars)?.volume || 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : null;
  const wedge = contraction(bars);
  const base = findBase(bars);
  const low5 = Math.min(...windowOf(bars, 5).map((b) => b.low));
  const low20 = Math.min(...windowOf(bars, 20).map((b) => b.low));
  const uptrend = lastPx > ema50 && ema20 > ema50;
  const downtrend = lastPx < ema50 && ema20 < ema50;
  const picked = scoreStages({
    bars, lastPx, ema10, ema20, ema50, ema200, atr, ret5, ret10, ret20,
    volRatio, wedge, base, uptrend, downtrend, low5, low20
  });
  const stage = picked.stage;
  const stop = stopFor(stage, { lastPx, atr, ema20, wedge, base, low5 });
  const regime = regimeOf(qqqBars);
  const catalyst = catalystScore(meta);
  const parts = componentScores({
    lastPx, ema20, ema50, ema200, ret20, rs20, rs5, volRatio, stage, regime, catalyst, stop, atr, wedge, base
  });
  const score = Math.round(
    parts.trend + parts.rs + parts.volume + parts.structure + parts.regime + parts.catalyst + parts.rr
  );
  const tradeable = TRADEABLE.has(stage.id);
  const allowNewLong = tradeable && score >= 80 && regime.id !== 'risk-off';
  const watch = tradeable && score >= 70 && score < 80 && regime.id !== 'risk-off';
  return {
    ok: true,
    id: CYCLE_ID,
    name: CYCLE_NAME,
    stage: stage.id,
    stageNo: stage.no,
    stageLabel: stage.label,
    score,
    tradeable,
    allowNewLong,
    watch,
    sizeR: allowNewLong ? stage.sizeR : 0,
    confidence: Number(picked.confidence.toFixed(2)),
    regime: regime.id,
    regimeLabel: regime.label,
    rs20: rs20 == null ? null : Number(rs20.toFixed(2)),
    volumeRatio: volRatio == null ? null : Number(volRatio.toFixed(2)),
    stop,
    atr: roundPx(atr, lastPx),
    atrPct: lastPx > 0 ? Number(((atr / lastPx) * 100).toFixed(2)) : null,
    ema10: roundPx(ema10, lastPx),
    ema20: roundPx(ema20, lastPx),
    ema50: roundPx(ema50, lastPx),
    last: roundPx(lastPx, lastPx),
    scores: parts,
    catalystNote: catalyst.note,
    note: summarize(stage, score, regime, rs20, volRatio, allowNewLong)
  };
}

function summarize(stage, score, regime, rs20, volRatio, allowNewLong) {
  const rs = rs20 == null ? 'RS 缺数据' : `RS20 ${rs20 >= 0 ? '+' : ''}${rs20.toFixed(1)}`;
  const vol = volRatio == null ? '量 缺数据' : `量能 ${volRatio.toFixed(1)}x`;
  const gate = allowNewLong ? '可开' : (TRADEABLE.has(stage.id) ? '观察' : '禁止新开多');
  return `${stage.label} · ${score}分 · ${regime.label} · ${rs} · ${vol} · ${gate}`;
}

function unavailable(reason) {
  return {
    ok: false,
    id: CYCLE_ID,
    name: CYCLE_NAME,
    stage: STAGES.UNKNOWN.id,
    stageNo: 0,
    stageLabel: STAGES.UNKNOWN.label,
    score: null,
    tradeable: false,
    allowNewLong: false,
    watch: false,
    sizeR: 0,
    confidence: 0,
    regime: 'unknown',
    regimeLabel: 'DATA UNAVAILABLE',
    rs20: null,
    volumeRatio: null,
    stop: null,
    atr: null,
    atrPct: null,
    scores: null,
    note: `DATA UNAVAILABLE：${reason}`
  };
}

export function strategyLabel(cycle) {
  if (!cycle) return '—';
  if (!cycle.ok || cycle.score == null) return cycle.note || 'DATA UNAVAILABLE';
  return `${cycle.stageLabel} · ${cycle.score}`;
}

export function isCycleEntry(row, minScore = 80) {
  const s = row?.strategy;
  if (!s || s.id !== CYCLE_ID) return false;
  if (s.version === STRATEGY_VERSION) return s.allowNewLong === true && s.confirmation?.confirmed === true;
  if (s.allowNewLong === true) return true;
  return s.tradeable === true && Number(s.score) >= minScore && s.regime !== 'risk-off';
}

export function isCycleExit(row) {
  const s = row?.strategy;
  if (!s || s.stage !== STAGES.DROP.id) return false;
  // 只靠跌破一项给 40 分，confidence=0.5；止损必须及时，所以 0.5 就算确认跌破。
  return Number(s.confidence || 0) >= 0.5;
}

export function isCycleTrim(row) {
  const s = row?.strategy;
  if (!s || s.stage !== STAGES.EXHAUSTION.id) return false;
  return Number(s.confidence || 0) >= 0.55;
}

export function attachStrategy(row, cycle) {
  const s = cycle || unavailable('未扫描');
  return {
    ...row,
    strategy: {
      id: s.id,
      version: s.version,
      experimental: s.experimental,
      signalDate: s.signalDate,
      confirmation: s.confirmation,
      riskPlan: s.riskPlan,
      name: s.name,
      stage: s.stage,
      stageNo: s.stageNo,
      stageLabel: s.stageLabel,
      score: s.score,
      tradeable: s.tradeable,
      allowNewLong: s.allowNewLong,
      watch: s.watch,
      sizeR: s.sizeR,
      confidence: s.confidence,
      regime: s.regime,
      regimeLabel: s.regimeLabel,
      rs20: s.rs20,
      volumeRatio: s.volumeRatio,
      stop: s.stop,
      atr: s.atr,
      atrPct: s.atrPct,
      scores: s.scores,
      note: s.note
    }
  };
}

export async function loadCycleBook(symbols, { bySymbol = {}, lastBySymbol = {}, concurrency = 5 } = {}) {
  const unique = [...new Set(symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))];
  const hist = await loadManyHistoricals([...unique, BENCHMARK], { concurrency });
  const qqq = hist[BENCHMARK]?.ok ? closedBars(hist[BENCHMARK].bars) : [];
  const out = {};
  for (const symbol of unique) {
    const pack = hist[symbol];
    const meta = bySymbol[symbol] || {};
    if (!pack?.ok) {
      out[symbol] = unavailable(pack?.error || '无日线');
      continue;
    }
    const override = num(lastBySymbol[symbol]);
    const bars = closedBars(pack.bars);
    const asOf = bars.at(-1)?.date;
    out[symbol] = classifyBars(bars, {
      qqqBars: qqq.filter((bar) => bar.date <= asOf),
      meta,
      lastOverride: override > 0 ? override : undefined
    });
  }
  const regime = regimeOf(qqq);
  return {
    ok: true,
    id: CYCLE_ID,
    name: CYCLE_NAME,
    benchmark: BENCHMARK,
    version: STRATEGY_VERSION,
    regime: regime.id,
    regimeLabel: regime.label,
    counted: unique.length,
    tradeable: unique.filter((s) => out[s]?.allowNewLong).length,
    bySymbol: out
  };
}

export async function loadOneCycle(symbol, meta = {}) {
  const book = await loadCycleBook([symbol], { bySymbol: { [String(symbol).toUpperCase()]: meta } });
  return book.bySymbol[String(symbol).toUpperCase()] || unavailable('未扫描');
}
