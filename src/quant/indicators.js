import { atrValue, emaSeries } from '../levels.js';

export { atrValue, emaSeries };

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function adxValue(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period * 2 + 1) return null;
  const plus = [];
  const minus = [];
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }
  let smTr = sum(trs.slice(0, period));
  let smPlus = sum(plus.slice(0, period));
  let smMinus = sum(minus.slice(0, period));
  const dxs = [];
  const pushDx = () => {
    if (!(smTr > 0)) return;
    const pdi = 100 * smPlus / smTr;
    const mdi = 100 * smMinus / smTr;
    const denom = pdi + mdi;
    if (!(denom > 0)) return;
    dxs.push(100 * Math.abs(pdi - mdi) / denom);
  };
  pushDx();
  for (let i = period; i < trs.length; i += 1) {
    smTr = smTr - smTr / period + trs[i];
    smPlus = smPlus - smPlus / period + plus[i];
    smMinus = smMinus - smMinus / period + minus[i];
    pushDx();
  }
  if (dxs.length < period) return null;
  let adx = sum(dxs.slice(0, period)) / period;
  for (let i = period; i < dxs.length; i += 1) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return adx;
}

export function windowReturn(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length <= n) return null;
  const last = bars[bars.length - 1]?.close;
  const base = bars[bars.length - 1 - n]?.close;
  if (!(last > 0) || !(base > 0)) return null;
  return last / base - 1;
}

function span(bars) {
  if (!bars?.length) return { ready: false, high: null, low: null };
  return {
    ready: true,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low))
  };
}

export function structureOf(bars) {
  const list = bars || [];
  const s20 = span(list.slice(-20));
  const prior20 = list.length >= 40 ? span(list.slice(-40, -20)) : { ready: false };
  const s60 = list.length >= 60 ? span(list.slice(-60)) : { ready: false };
  const prior60 = list.length >= 120 ? span(list.slice(-120, -60)) : { ready: false };
  const rising20 = Boolean(s20.ready && prior20.ready && s20.high > prior20.high && s20.low > prior20.low);
  const falling20 = Boolean(s20.ready && prior20.ready && s20.high < prior20.high && s20.low < prior20.low);
  const rising60 = Boolean(s60.ready && prior60.ready && s60.high > prior60.high && s60.low > prior60.low);
  return { high20: s20.high, low20: s20.low, high60: s60.high, low60: s60.low, rising20, falling20, rising60 };
}

export function trueRange(bars) {
  if (!bars?.length) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  if (!prev) return last.high - last.low;
  return Math.max(last.high - last.low, Math.abs(last.high - prev.close), Math.abs(last.low - prev.close));
}

/** 整理平台：近端区间够窄，且前面有一段上涨。没有就返回 null。 */
export function baseHighOf(bars) {
  if (!bars || bars.length < 40) return null;
  const box = bars.slice(-25, -3);
  const prior = bars.slice(-60, -25);
  if (box.length < 15 || prior.length < 15) return null;
  const high = Math.max(...box.map((bar) => bar.high));
  const low = Math.min(...box.map((bar) => bar.low));
  const mid = (high + low) / 2;
  const width = mid > 0 ? (high - low) / mid : 1;
  const priorUp = prior[prior.length - 1].close > prior[0].close * 1.05;
  if (width < 0.16 && priorUp) return high;
  return null;
}
