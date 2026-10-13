/** 掘金涨停回调抄底。日线能核对的条件才开仓；Level-2、封单、DDE 没有数据源，不假装通过。 */

export function chinaSessionClosed(day, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  return Boolean(day && (day < today || (day === today && Number(get('hour')) >= 15)));
}

const FX = 7.2;

export const LIMIT_PULLBACK = {
  id: 'limit-pullback-v1',
  cashFloorPct: 0.1,
  maxPositions: 4,
  maxNewOpens: 2,
  weight4: 0.23,
  weight3: 0.3,
  maxWeight: 0.33,
  maxPullback: 0.15,
  halfTake: 0.05,
  fullTake: 0.08,
  halfStop: 0.04,
  fullStop: 0.06,
  maxHold: 5,
  flatDays: 3,
  flatBand: 0.01,
  minAmountCny: 1e8,
  minFloatCny: 50e8,
  maxFloatCny: 200e8,
  volumeSpike: 1.5
};

export function amountFloor(market) {
  return market === 'us' ? LIMIT_PULLBACK.minAmountCny / FX : LIMIT_PULLBACK.minAmountCny;
}

export function floatBand(market) {
  const scale = market === 'us' ? 1 / FX : 1;
  return {
    min: LIMIT_PULLBACK.minFloatCny * scale,
    max: LIMIT_PULLBACK.maxFloatCny * scale
  };
}

export function limitPct(symbol, market) {
  if (market === 'us') return 0.08;
  const text = String(symbol || '');
  if (text.startsWith('30') || text.startsWith('68')) return 0.195;
  if (text.startsWith('8') || text.startsWith('4')) return 0.295;
  return 0.095;
}

export function isStrongBar(bar, prev, symbol, market) {
  if (!(prev?.close > 0) || !(bar?.close > 0) || !(bar.high > 0)) return false;
  const gain = bar.close / prev.close - 1;
  return gain + 1e-9 >= limitPct(symbol, market) && bar.close >= bar.high * 0.997;
}

export function boardShape(bars, index, symbol, market) {
  const bar = bars[index];
  const prev = bars[index - 1];
  if (!isStrongBar(bar, prev, symbol, market)) return null;
  const pct = limitPct(symbol, market);
  const gap = bar.open > 0 ? bar.open / prev.close - 1 : 0;
  if (gap >= pct * 0.6) return 'pulse';
  const prior = [index - 3, index - 2, index - 1]
    .map((at) => (at > 0 && bars[at - 1]?.close > 0 ? bars[at].close / bars[at - 1].close - 1 : null))
    .filter((n) => n != null);
  if (prior.length === 3 && prior.reduce((sum, n) => sum + n, 0) >= 0.15) return 'diagonal';
  const stair = index >= 3
    && bars[index - 1].close > bars[index - 2].close
    && bars[index - 2].close > bars[index - 3].close;
  if (stair && gap < 0.03) return 'ladder';
  const range = (bar.high - bar.low) / prev.close;
  if (range >= 0.04 && bar.open > 0 && bar.open <= bar.close * 0.97) return 'range';
  return 'other';
}

export function boardRun(bars, end, symbol, market) {
  if (end < 1) return null;
  let count = 0;
  let at = end;
  while (at > 0 && isStrongBar(bars[at], bars[at - 1], symbol, market)) {
    count += 1;
    at -= 1;
  }
  if (!count) return null;
  return { count, end, shape: boardShape(bars, end, symbol, market) };
}

function sma(bars, length, index) {
  if (index + 1 < length) return null;
  let sum = 0;
  for (let i = index - length + 1; i <= index; i += 1) sum += bars[i].close;
  return sum / length;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/** 最近一根已收盘 K 线是否给出抄底买点。 */
export function floatOk(floatCap, market) {
  const band = floatBand(market);
  if (!(floatCap > 0)) return { ok: false, reason: '缺流通市值' };
  if (floatCap < band.min || floatCap > band.max) return { ok: false, reason: '流通市值不在 50–200 亿区间' };
  return { ok: true };
}

export function entrySetup(bars, { symbol, market, company = '' } = {}) {
  const deny = (reason) => ({ ok: false, reason });
  if (/ST/i.test(String(company || ''))) return deny('ST');
  if (!Array.isArray(bars) || bars.length < 25) return deny('日线不足');
  const n = bars.length - 1;
  const last = bars[n];
  if (isStrongBar(last, bars[n - 1], symbol, market)) return deny('当天仍是大涨板，不追');
  const amounts = bars.slice(n - 4, n + 1).map((bar) => bar.close * bar.volume);
  const avgAmount = mean(amounts);
  if (!(avgAmount >= amountFloor(market))) return deny('近 5 日成交额不足 1 亿');

  let run = null;
  for (let ago = 1; ago <= 3; ago += 1) {
    const found = boardRun(bars, n - ago, symbol, market);
    if (found && found.end === n - ago) {
      run = found;
      break;
    }
  }
  if (!run) return deny('近 3 日没有涨停或大涨板');
  if (run.count >= 3) return deny('三板及以上，不做');
  if (run.count < 1 || run.count > 2) return deny('不是首板或二板');
  if (!['ladder', 'range'].includes(run.shape)) return deny(`形态 ${run.shape || '无法归类'}，只留阶梯和震荡`);

  const boardClose = bars[run.end].close;
  let trough = boardClose;
  for (let i = run.end + 1; i <= n; i += 1) {
    const line = sma(bars, 10, i);
    if (!(line > 0) || bars[i].close < line) return deny('回调跌破 10 日线');
    trough = Math.min(trough, bars[i].close);
  }
  if ((boardClose - trough) / boardClose > LIMIT_PULLBACK.maxPullback + 1e-9) return deny('回调超过 15%');
  const ma5 = sma(bars, 5, n);
  const prevMa5 = sma(bars, 5, n - 1);
  const ma10 = sma(bars, 10, n);
  if (!(last.close > ma10) || !(prevMa5 > 0) || !(ma5 > 0)) return deny('均线不足');
  if (!(bars[n - 1].close < prevMa5 && last.close >= ma5)) return deny('还在 5 日线下，等放量站上');
  const baseVol = mean(bars.slice(n - 5, n).map((bar) => bar.volume));
  if (!(baseVol > 0) || last.volume < baseVol * LIMIT_PULLBACK.volumeSpike) return deny('突破 5 日线但没有放量');
  return {
    ok: true,
    reason: '放量站上 5 日线',
    shape: run.shape,
    boards: run.count,
    boardDate: bars[run.end].date,
    ma5,
    ma10
  };
}

export function selectXiaomeng({ market, barsBySymbol = {}, lists = {}, members = {}, caps = {}, companies = {} } = {}) {
  const buys = [];
  const skipped = [];
  let scanned = 0;
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (!bars?.length) continue;
    scanned += 1;
    const setup = entrySetup(bars, { symbol, market, company: companies[symbol] });
    if (!setup.ok) continue;
    const cap = floatOk(caps[symbol], market);
    if (!cap.ok) {
      skipped.push({ symbol, reason: 'float', message: cap.reason });
      continue;
    }
    const sector = sectorResonance(symbol, { lists, members, barsBySymbol, market });
    if (!sector.ok) {
      skipped.push({ symbol, reason: 'sector', message: sector.reason });
      continue;
    }
    buys.push({ symbol, ...setup, list: sector.list, price: bars.at(-1).close });
  }
  return { scanned, buys, skipped };
}

export function sectorResonance(symbol, { lists = {}, members = {}, barsBySymbol = {}, market = 'cn' } = {}) {
  const titles = lists[symbol] || [];
  for (const title of titles) {
    const names = members[title] || [];
    const returns = [];
    let boards = 0;
    for (const name of names) {
      const bars = barsBySymbol[name];
      if (!bars || bars.length < 4) continue;
      const prior = bars.at(-3);
      const yesterday = bars.at(-2);
      if (prior.close > 0) returns.push(yesterday.close / prior.close - 1);
      const run = boardRun(bars, bars.length - 2, name, market);
      if (run?.end === bars.length - 2 && run.count >= 1 && run.count <= 2 && ['ladder', 'range'].includes(run.shape)) boards += 1;
    }
    returns.sort((a, b) => a - b);
    const mid = returns.length ? returns[Math.floor((returns.length - 1) / 2)] : null;
    if (mid != null && mid >= 0.03 && boards >= 3) return { ok: true, list: title, boards, priorReturn: mid };
  }
  return { ok: false, reason: '板块共振不足：前一日板块涨幅或涨停家数不够' };
}

export function sizeLimitPullback({ nav, cash, price, lot = 1, positions = 0 } = {}) {
  if (!(nav > 0) || !(price > 0) || !(lot >= 1)) return null;
  const spendable = cash - nav * LIMIT_PULLBACK.cashFloorPct;
  const slots = Math.min(LIMIT_PULLBACK.maxPositions, Math.max(3, positions + 1));
  const weight = Math.min(LIMIT_PULLBACK.maxWeight, slots >= 4 ? LIMIT_PULLBACK.weight4 : LIMIT_PULLBACK.weight3);
  const budget = Math.min(spendable, nav * weight);
  if (!(budget > 0)) return null;
  const qty = Math.floor(budget / price / lot) * lot;
  if (qty < lot) return null;
  const stop = Number((price * (1 - LIMIT_PULLBACK.fullStop)).toFixed(4));
  return { qty, stop, maxLoss: Number((qty * (price - stop)).toFixed(2)), weight };
}

function lotSlice(qty, lot, fraction) {
  const raw = Math.floor((qty * fraction) / lot) * lot;
  return raw >= lot ? raw : 0;
}

/** 日线卖点。30 分钟收回和盘中涨停瞬间无法观察，收盘跌破 10 日线或当天收成大涨板就按规则处理。 */
export function exitSetup(pos, bars, { market = 'cn', lot = 1, halfTake = false, halfStop = false } = {}) {
  const hold = (reason, label) => ({ action: 'HOLD', qty: 0, reason, label });
  if (!pos || !(pos.qty > 0) || !bars?.length) return hold('missing', '没有持仓或日线');
  const n = bars.length - 1;
  const last = bars[n];
  const entry = Number(pos.avgCost);
  if (!(entry > 0) || !(last.close > 0)) return hold('price', '缺价格');
  const pnl = Number((last.close / entry - 1).toFixed(4));
  const ma10 = sma(bars, 10, n);
  const held = bars.filter((bar) => bar.date >= pos.entryDate && bar.date <= last.date).length;
  const strong = isStrongBar(last, bars[n - 1], pos.symbol, market);
  const all = (reason, label) => ({ action: 'SELL', qty: pos.qty, reason, label });
  if (ma10 > 0 && last.close < ma10) return all('ma10', '收盘跌破 10 日线，清仓');
  if (pnl <= -LIMIT_PULLBACK.fullStop) return all('stop6', '亏损达到 6%，清仓');
  if (held >= LIMIT_PULLBACK.maxHold) return all('day5', '持仓满 5 个交易日，尾盘清仓');
  if (strong) return all('board', '持仓当天收成大涨板，清仓');
  if (pnl >= LIMIT_PULLBACK.fullTake) return all('take8', '盈利达到 8%，清仓');
  if (pnl <= -LIMIT_PULLBACK.halfStop && !halfStop) {
    const qty = lotSlice(pos.qty, lot, 0.5);
    if (qty > 0 && qty < pos.qty) return { action: 'SELL', qty, reason: 'stop4', label: '亏损达到 4%，卖出一半' };
  }
  if (pnl >= LIMIT_PULLBACK.halfTake && !halfTake) {
    const qty = lotSlice(pos.qty, lot, 0.5);
    if (qty > 0 && qty < pos.qty) return { action: 'SELL', qty, reason: 'take5', label: '盈利达到 5%，卖出一半' };
  }
  if (held >= LIMIT_PULLBACK.flatDays && Math.abs(pnl) < LIMIT_PULLBACK.flatBand) {
    return all('flat', '3 个交易日没有拉开，保本换仓');
  }
  return hold('wait', '止盈止损都没到，继续拿');
}
