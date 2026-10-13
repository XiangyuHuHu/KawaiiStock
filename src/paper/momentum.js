/**
 * 0F Claude 动量：横截面「波动调整动量」轮动。
 * 和 0A–0C 的 Cycle 形态、0D 算卦、0E 期权都不同：不看单根 K 线形态，
 * 只按 6 个月涨幅 / 年化波动给全 list 排名，买趋势里最强的，ATR 吊灯止损。
 */

export const MOMENTUM_ID = 'claude-momentum-v1';

const LEVERED = new Set([
  'QLD', 'SSO', 'NVDL', 'USD', 'ROM', 'UYG', 'DIG', 'ERX', 'BOIL', 'AGQ', 'AAOX', 'IREX', 'SPCH',
  'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA', 'SPXL', 'SPXS', 'TECL', 'TECS', 'FAS', 'FAZ', 'LABU', 'LABD'
]);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sma = (xs, n) => (xs.length >= n ? mean(xs.slice(-n)) : null);

export function momentumUniverse(symbols) {
  return [...new Set((symbols || []).map((s) => String(s || '').toUpperCase()))]
    .filter((s) => /^[A-Z][A-Z.]{0,5}$/.test(s) && !LEVERED.has(s));
}

/** 只用已收盘日线；盘中当天那根不进信号。 */
export function closedBars(bars, day) {
  return (bars || []).filter((row) => row?.date && (!day || row.date < day));
}

export function atr(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const trs = [];
  for (let i = bars.length - n; i < bars.length; i += 1) {
    const cur = bars[i], prev = bars[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  return mean(trs);
}

export function momentumSignal(bars) {
  if (!Array.isArray(bars) || bars.length < 200) return { ok: false, eligible: false, reasons: ['日线不足 200 根'] };
  const closes = bars.map((row) => row.close);
  const last = closes.at(-1);
  const sma50 = sma(closes, 50), sma100 = sma(closes, 100), sma200 = sma(closes, 200);
  const lookback = Math.min(131, closes.length - 1);
  const ret = closes.at(-6) / closes.at(-lookback) - 1;
  const logs = [];
  for (let i = closes.length - 63; i < closes.length; i += 1) logs.push(Math.log(closes[i] / closes[i - 1]));
  const mu = mean(logs);
  const vol = Math.sqrt(mean(logs.map((x) => (x - mu) ** 2)) * 252);
  const range = atr(bars, 14);
  const dollarVol = mean(bars.slice(-20).map((row) => row.close * (row.volume || 0)));
  const high252 = Math.max(...closes.slice(-252));
  const score = vol > 0 ? ret / vol : null;
  const reasons = [];
  if (!(last > sma50 && sma50 > sma200)) reasons.push('没站上 50/200 日线多头排列');
  if (!(ret > 0)) reasons.push('6 个月动量不为正');
  if (!(last >= 10)) reasons.push('股价低于 $10');
  if (!(dollarVol >= 20_000_000)) reasons.push('20 日成交额不足 $2000 万');
  if (last < high252 * 0.75) reasons.push('离一年高点超过 25%');
  if (range > 0 && (last - sma50) / range > 8) reasons.push('离 50 日线超过 8 个 ATR，过度延伸');
  if (!(range > 0)) reasons.push('ATR 缺失');
  return {
    ok: true,
    eligible: reasons.length === 0 && score != null,
    score: score == null ? null : Number(score.toFixed(3)),
    ret: Number(ret.toFixed(4)),
    vol: Number(vol.toFixed(4)),
    atr: range,
    last,
    sma50,
    sma100,
    sma200,
    signalDate: bars.at(-1).date,
    reasons
  };
}

/** 大盘开关：SPY 和 QQQ 都在 200 日线上方才开新仓。 */
export function regimeOn(...benchBars) {
  return benchBars.every((bars) => {
    const closes = (bars || []).map((row) => row.close);
    const s200 = sma(closes, 200);
    return s200 != null && closes.at(-1) > s200;
  });
}

export function rankMomentum(signals) {
  return Object.entries(signals || {})
    .filter(([, sig]) => sig?.eligible)
    .sort(([a, x], [b, y]) => y.score - x.score || a.localeCompare(b))
    .map(([symbol, sig], index) => ({ symbol, rank: index + 1, ...sig }));
}

/** 持仓排名不看入场过滤（延伸、离高点等），只要动量为正就参与排名。 */
export function holdRankable(signals) {
  return Object.fromEntries(Object.entries(signals || {})
    .filter(([, sig]) => sig?.ok && sig.score != null && sig.score > 0)
    .map(([symbol, sig]) => [symbol, { ...sig, eligible: true }]));
}

/** 吊灯止损：持有以来最高收盘 − mult × ATR。只上移。 */
export function chandelierStop(bars, sinceDate, range, mult = 3) {
  if (!(range > 0)) return null;
  const since = (bars || []).filter((row) => !sinceDate || row.date >= sinceDate);
  if (!since.length) return null;
  return Math.max(...since.map((row) => row.close)) - mult * range;
}

/** 止损优先：破吊灯止损 → 收盘跌破 100 日线 → 排名掉出 keepRank。 */
export function momentumExit({ last, stop, signal, rank, keepRank = 20 }) {
  if (last > 0 && stop > 0 && last <= stop) return 'stop';
  if (signal?.ok && signal.sma100 > 0 && signal.last < signal.sma100) return 'trend';
  if (signal?.ok && (rank == null || rank > keepRank)) return 'rank';
  return null;
}

export function momentumStop(last, range, mult = 3) {
  if (!(last > 0) || !(range > 0)) return null;
  const raw = last - mult * range;
  return Number(Math.min(last * 0.96, Math.max(last * 0.85, raw)).toFixed(2));
}

/** 每仓风险 riskPct × NAV，名义不超过 maxNamePct，现金保留 cashFloorPct。 */
export function sizeMomentum({ nav, cash, price, stop, riskPct = 0.01, maxNamePct = 0.125, cashFloorPct = 0.05 }) {
  if (![nav, cash, price, stop].every(Number.isFinite) || !(nav > 0 && price > stop && stop > 0)) return null;
  const spendable = Math.max(0, cash - nav * cashFloorPct);
  const qty = Math.floor(Math.min((nav * riskPct) / (price - stop), (nav * maxNamePct) / price, spendable / price));
  return qty > 0 ? { qty, maxLoss: Number((qty * (price - stop)).toFixed(2)), notional: qty * price } : null;
}
