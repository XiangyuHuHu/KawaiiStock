/** 掘金涨停回调抄底。日线能核对的条件才开仓。盘口、封单、集合竞价没有数据时记为中性，不因此否决。 */

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

/** A 股保持原规则：涨停、流通市值 50–200 亿、同名单至少 3 只共振。 */
export const CN_PULLBACK = {
  id: 'cn-v1',
  strongPct: null,
  closeNearHigh: 0.997,
  minFloat: LIMIT_PULLBACK.minFloatCny,
  maxFloat: LIMIT_PULLBACK.maxFloatCny,
  minBoards: 3,
  minListReturn: 0.03,
  missingMicrostructure: 'neutral'
};

/**
 * 旧美股对照。流通市值约 $0.69B–$2.78B（50–200 亿人民币 / 7.2），大涨 8%，同名单至少 3 只。
 * 盘口缺失在旧代码里没有写成否决，只是注释说「不假装通过」。v1-fail 才把缺失当成否决，用来对照假设。
 */
export const US_PULLBACK_V1 = {
  id: 'us-v1',
  strongPct: 0.08,
  closeNearHigh: 0.997,
  minFloat: LIMIT_PULLBACK.minFloatCny / FX,
  maxFloat: LIMIT_PULLBACK.maxFloatCny / FX,
  minBoards: 3,
  minListReturn: 0.03,
  missingMicrostructure: 'neutral'
};

/**
 * 美股没有 10% 涨停。5% 且收在高点附近大约是两倍日波动，名单上一个月能出现几次。
 * 流通市值放到 $0.5B–$20B：原带 $0.7B–$2.8B 把主题名单里的中型股几乎全挡在外面，又还没放到超大盘。
 * 共振从 3 只 / 中位数 3% 降到 2 只 / 1%。美股名单比 A 股涨停潮稀疏，3 只同一天都收在高点附近很少见。
 */
export const US_PULLBACK = {
  id: 'us-v2',
  strongPct: 0.05,
  closeNearHigh: 0.995,
  minFloat: 0.5e9,
  maxFloat: 20e9,
  minBoards: 2,
  minListReturn: 0.01,
  missingMicrostructure: 'neutral'
};

export function marketRules(market, rules) {
  if (rules) return rules;
  return market === 'us' ? US_PULLBACK : CN_PULLBACK;
}

export function amountFloor(market) {
  return market === 'us' ? LIMIT_PULLBACK.minAmountCny / FX : LIMIT_PULLBACK.minAmountCny;
}

export function floatBand(market, rules = marketRules(market)) {
  return { min: rules.minFloat, max: rules.maxFloat };
}

export function limitPct(symbol, market, rules = marketRules(market)) {
  if (market === 'us') return rules.strongPct;
  const text = String(symbol || '');
  if (text.startsWith('30') || text.startsWith('68')) return 0.195;
  if (text.startsWith('8') || text.startsWith('4')) return 0.295;
  return 0.095;
}

export function isStrongBar(bar, prev, symbol, market, rules = marketRules(market)) {
  if (!(prev?.close > 0) || !(bar?.close > 0) || !(bar.high > 0)) return false;
  const gain = bar.close / prev.close - 1;
  const pct = market === 'us' ? rules.strongPct : limitPct(symbol, 'cn');
  return gain + 1e-9 >= pct && bar.close >= bar.high * rules.closeNearHigh;
}

export function boardShape(bars, index, symbol, market, rules = marketRules(market)) {
  const bar = bars[index];
  const prev = bars[index - 1];
  if (!isStrongBar(bar, prev, symbol, market, rules)) return null;
  const pct = market === 'us' ? rules.strongPct : limitPct(symbol, 'cn');
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

export function boardRun(bars, end, symbol, market, rules = marketRules(market)) {
  if (end < 1) return null;
  let count = 0;
  let at = end;
  while (at > 0 && isStrongBar(bars[at], bars[at - 1], symbol, market, rules)) {
    count += 1;
    at -= 1;
  }
  if (!count) return null;
  return { count, end, shape: boardShape(bars, end, symbol, market, rules) };
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
export function floatOk(floatCap, market, rules = marketRules(market)) {
  const band = floatBand(market, rules);
  if (!(floatCap > 0)) return { ok: false, reason: '缺流通市值' };
  if (floatCap < band.min || floatCap > band.max) {
    const reason = market === 'us'
      ? `总市值不在 $${(band.min / 1e9).toFixed(1)}B–$${Math.round(band.max / 1e9)}B`
      : '流通市值不在 50–200 亿区间';
    return { ok: false, reason };
  }
  return { ok: true };
}

/** 盘中已经走出大涨板就不再追。没有最高价时，涨幅到阈值也先让开。 */
export function liveChase({ market = 'cn', symbol, changePct, last, high, rules = marketRules(market) } = {}) {
  const pct = (market === 'us' ? rules.strongPct : limitPct(symbol, market, rules)) * 100;
  if (!(Number(changePct) >= pct - 0.05)) return false;
  if (Number(high) > 0 && Number(last) > 0) return last >= high * rules.closeNearHigh;
  return true;
}

export function microstructureGate(book, rules = marketRules('us')) {
  const src = book || {};
  const hasDepth = Number(src.bidSize) > 0 && Number(src.askSize) > 0;
  const hasAuction = src.auctionImbalance != null || Number(src.auctionVolume) > 0 || Number(src.sealAmount) > 0 || Number(src.dde) > 0;
  if (hasDepth || hasAuction) return { ok: true, neutral: false, reason: '盘口或集合竞价有数据，不另设否决' };
  if (rules.missingMicrostructure === 'fail') return { ok: false, neutral: false, reason: '盘口与集合竞价缺失' };
  return { ok: true, neutral: true, reason: '盘口、封单、集合竞价没有数据源，记为中性，不因此否决' };
}

export function entrySetup(bars, { symbol, market, company = '', rules = marketRules(market) } = {}) {
  const deny = (reason) => ({ ok: false, reason });
  if (/ST/i.test(String(company || ''))) return deny('ST');
  if (!Array.isArray(bars) || bars.length < 25) return deny('日线不足');
  const n = bars.length - 1;
  const last = bars[n];
  if (isStrongBar(last, bars[n - 1], symbol, market, rules)) return deny('当天仍是大涨板，不追');
  const amounts = bars.slice(n - 4, n + 1).map((bar) => bar.close * bar.volume);
  const avgAmount = mean(amounts);
  if (!(avgAmount >= amountFloor(market))) return deny('近 5 日成交额不足 1 亿');

  let run = null;
  for (let ago = 1; ago <= 3; ago += 1) {
    const found = boardRun(bars, n - ago, symbol, market, rules);
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

export function selectXiaomeng({ market, barsBySymbol = {}, lists = {}, members = {}, caps = {}, companies = {}, rules = marketRules(market), book } = {}) {
  const buys = [];
  const skipped = [];
  const rejections = {};
  const bump = (reason) => { rejections[reason] = (rejections[reason] || 0) + 1; };
  let scanned = 0;
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (!bars?.length) continue;
    scanned += 1;
    const setup = entrySetup(bars, { symbol, market, company: companies[symbol], rules });
    if (!setup.ok) {
      bump(setup.reason);
      continue;
    }
    const cap = floatOk(caps[symbol], market, rules);
    if (!cap.ok) {
      bump(cap.reason);
      skipped.push({ symbol, reason: 'float', message: cap.reason });
      continue;
    }
    const sector = sectorResonance(symbol, { lists, members, barsBySymbol, market, rules });
    if (!sector.ok) {
      bump(sector.reason);
      skipped.push({ symbol, reason: 'sector', message: sector.reason });
      continue;
    }
    buys.push({ symbol, ...setup, list: sector.list, price: bars.at(-1).close });
  }
  const microstructure = microstructureGate(book, rules);
  if (!microstructure.ok) {
    for (const row of buys) {
      bump(microstructure.reason);
      skipped.push({ symbol: row.symbol, reason: 'microstructure', message: microstructure.reason });
    }
    return { scanned, buys: [], skipped, rejections, microstructure, rules: rules.id };
  }
  return { scanned, buys, skipped, rejections, microstructure, rules: rules.id };
}

export function replayPullbackSignals({ market = 'us', barsBySymbol = {}, lists = {}, members = {}, caps = {}, companies = {}, rules, from, to } = {}) {
  const dates = [...new Set(Object.values(barsBySymbol).flatMap((bars) => (bars || []).map((bar) => bar.date)))].sort();
  const events = [];
  for (const date of dates) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const sliced = {};
    for (const [symbol, bars] of Object.entries(barsBySymbol)) {
      const rows = (bars || []).filter((bar) => bar.date <= date);
      if (rows.length && rows.at(-1).date === date) sliced[symbol] = rows;
    }
    const picked = selectXiaomeng({ market, barsBySymbol: sliced, lists, members, caps, companies, rules });
    if (picked.buys.length) events.push({ date, symbols: picked.buys.map((row) => row.symbol) });
  }
  const active = rules || marketRules(market);
  return {
    rules: active.id,
    signals: events.reduce((sum, row) => sum + row.symbols.length, 0),
    days: events.length,
    events
  };
}

export function sectorResonance(symbol, { lists = {}, members = {}, barsBySymbol = {}, market = 'cn', rules = marketRules(market) } = {}) {
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
      const run = boardRun(bars, bars.length - 2, name, market, rules);
      if (run?.end === bars.length - 2 && run.count >= 1 && run.count <= 2 && ['ladder', 'range'].includes(run.shape)) boards += 1;
    }
    returns.sort((a, b) => a - b);
    const mid = returns.length ? returns[Math.floor((returns.length - 1) / 2)] : null;
    if (mid != null && mid + 1e-12 >= rules.minListReturn && boards >= rules.minBoards) return { ok: true, list: title, boards, priorReturn: mid };
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
  const strong = isStrongBar(last, bars[n - 1], pos.symbol, market, marketRules(market));
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
