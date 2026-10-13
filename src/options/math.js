const SQRT2PI = Math.sqrt(2 * Math.PI);

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function mean(xs) {
  const nums = xs.filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function stdev(xs) {
  const nums = xs.filter((n) => Number.isFinite(n));
  if (nums.length < 3) return null;
  const m = mean(nums);
  const v = nums.reduce((s, n) => s + (n - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

export function normCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev)
    ));
  }
  const slice = trs.slice(-period);
  if (slice.length < period) return null;
  return slice.reduce((s, n) => s + n, 0) / slice.length;
}

export function logReturns(bars) {
  const out = [];
  for (let i = 1; i < (bars || []).length; i += 1) {
    const a = bars[i - 1].close;
    const b = bars[i].close;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

export function realizedVol(bars, periodsPerYear) {
  const r = logReturns(bars);
  const s = stdev(r);
  if (s == null) return null;
  return s * Math.sqrt(periodsPerYear);
}

export function sessionVwap(bars) {
  const list = bars || [];
  if (!list.length) return null;
  const lastDay = String(list.at(-1).date).slice(0, 10);
  const session = list.filter((row) => String(row.date).slice(0, 10) === lastDay);
  let pv = 0;
  let vol = 0;
  for (const row of session) {
    const typical = (row.high + row.low + row.close) / 3;
    const v = row.volume || 0;
    pv += typical * v;
    vol += v;
  }
  if (vol <= 0) return session.at(-1)?.close ?? null;
  return pv / vol;
}

export function encodeReturn(ret, thresh) {
  if (ret > thresh) return 2;
  if (ret > 0) return 1;
  if (ret > -thresh) return -1;
  return -2;
}

export function encodeBars(bars, thresh) {
  const codes = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    const ret = prev > 0 ? (bars[i].close - prev) / prev : 0;
    codes.push(encodeReturn(ret, thresh));
  }
  return codes;
}

export function patternMatches(bars, { length = 8, horizon = 12, maxDist = 3, thresh = 0.003, sameSession = false } = {}) {
  const codes = encodeBars(bars, thresh);
  if (codes.length < length + horizon + 8) {
    return { ok: false, matches: 0, current: [], reason: 'bars-too-short' };
  }
  if (sameSession && String(bars.at(-length - 1)?.date).slice(0, 10) !== String(bars.at(-1)?.date).slice(0, 10)) return { ok: false, matches: 0, current: [], reason: 'current-pattern-crosses-session' };
  const current = codes.slice(-length);
  const ups = [];
  const downs = [];
  const fwd = [];
  const volExp = [];
  const lastIdx = codes.length - 1;
  const cutoff = lastIdx - length - horizon;
  let previousMatchEnd = -Infinity;
  for (let end = length - 1; end <= cutoff; end += 1) {
    if (end === lastIdx) continue;
    let dist = 0;
    for (let k = 0; k < length; k += 1) {
      dist += Math.abs(codes[end - length + 1 + k] - current[k]);
      if (dist > maxDist) break;
    }
    if (dist > maxDist) continue;
    if (end - previousMatchEnd < length + horizon) continue;
    const barEnd = end + 1;
    const later = bars[barEnd + horizon];
    const now = bars[barEnd];
    if (!later || !now || now.close <= 0) continue;
    if (sameSession) {
      const first = bars[barEnd - length];
      if (!first || String(first.date).slice(0, 10) !== String(later.date).slice(0, 10)) continue;
      if (!(later.ts > now.ts) || Math.abs(later.ts - now.ts - horizon * 300000) > 1000) continue;
    }
    previousMatchEnd = end;
    const ret = (later.close - now.close) / now.close;
    fwd.push(ret);
    if (ret >= 0) ups.push(ret);
    else downs.push(ret);
    const past = bars.slice(Math.max(1, barEnd - length), barEnd + 1);
    const future = bars.slice(barEnd, barEnd + horizon + 1);
    const periods = String(bars[0]?.date || '').includes('T') ? 78 * 252 : 252;
    const rv0 = realizedVol(past, periods);
    const rv1 = realizedVol(future, periods);
    if (rv0 > 0 && rv1 != null) volExp.push(rv1 > rv0);
  }
  const matches = fwd.length;
  const pUp = matches ? ups.length / matches : null;
  const pVolExpansion = volExp.length ? volExp.filter(Boolean).length / volExp.length : null;
  return {
    ok: matches >= 12,
    matches,
    current,
    thresh,
    maxDist,
    pUp,
    pDown: pUp == null ? null : 1 - pUp,
    avgUp: mean(ups),
    avgDown: mean(downs),
    avgFwd: mean(fwd),
    avgAbs: mean(fwd.map(Math.abs)),
    pVolExpansion,
    forwards: fwd
  };
}

export function fitPattern(bars, opts = {}) {
  const distances = opts.maxDists || [3, 4, 6, 8, 10];
  let best = patternMatches(bars, { ...opts, maxDist: distances[0] });
  for (const maxDist of distances.slice(1)) {
    if (best.matches >= 25) break;
    best = patternMatches(bars, { ...opts, maxDist });
  }
  return best;
}

export function blackScholes({ spot, strike, dte, iv, rate = 0.045, type = 'call' }) {
  const S = Number(spot);
  const K = Number(strike);
  const T = Math.max(Number(dte) || 0, 0.01) / 365;
  const sig = Math.max(Number(iv) || 0, 0.01);
  if (!(S > 0) || !(K > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (rate + 0.5 * sig * sig) * T) / (sig * sqrtT);
  const d2 = d1 - sig * sqrtT;
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nPd1 = normPdf(d1);
  const disc = Math.exp(-rate * T);
  const call = S * nd1 - K * disc * nd2;
  const put = K * disc * normCdf(-d2) - S * normCdf(-d1);
  const vega = S * nPd1 * sqrtT / 100;
  const callTheta = (-(S * nPd1 * sig) / (2 * sqrtT) - rate * K * disc * nd2) / 365;
  const putTheta = (-(S * nPd1 * sig) / (2 * sqrtT) + rate * K * disc * normCdf(-d2)) / 365;
  const isCall = type === 'call';
  return {
    price: isCall ? call : put,
    delta: isCall ? nd1 : nd1 - 1,
    gamma: nPd1 / (S * sig * sqrtT),
    theta: isCall ? callTheta : putTheta,
    vega,
    d1,
    d2
  };
}

export function impliedVolFromPrice({ spot, strike, dte, price, type = 'call' }) {
  const target = Number(price);
  if (!(target > 0) || !(spot > 0) || !(strike > 0)) return null;
  let lo = 0.02;
  let hi = 5;
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) / 2;
    const model = blackScholes({ spot, strike, dte, iv: mid, type });
    if (!model) return null;
    if (model.price > target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function analogOptionEv({ forwards, spot, strike, type, premium }) {
  if (!forwards?.length || !(spot > 0) || !(strike > 0) || !(premium >= 0)) return null;
  const payoffs = forwards.map((ret) => {
    const future = spot * (1 + ret);
    const intrinsic = type === 'call'
      ? Math.max(0, future - strike)
      : Math.max(0, strike - future);
    return intrinsic - premium;
  });
  return {
    ev: mean(payoffs),
    winRate: payoffs.filter((n) => n > 0).length / payoffs.length,
    avgWin: mean(payoffs.filter((n) => n > 0)),
    avgLoss: mean(payoffs.filter((n) => n <= 0))
  };
}

/** 信号视界内的期权盈亏：delta 捕捉股价 + theta 损耗 + 半个 spread。不是假设 60 分钟后到期。 */
export function horizonOptionEv({ forwards, spot, delta, theta = 0, spread = 0, horizonDays = 0.15 }) {
  if (!forwards?.length || !(spot > 0) || delta == null) return null;
  const slip = Math.max(spread || 0, 0) / 2;
  const payoffs = forwards.map((ret) => delta * spot * ret + (theta || 0) * horizonDays - slip);
  return {
    ev: mean(payoffs),
    winRate: payoffs.filter((n) => n > 0).length / payoffs.length,
    avgWin: mean(payoffs.filter((n) => n > 0)),
    avgLoss: mean(payoffs.filter((n) => n <= 0))
  };
}

export function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
