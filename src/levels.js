function roundPx(n, last) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const x = Number(n);
  if (last >= 100) return Math.round(x * 100) / 100;
  if (last >= 10) return Math.round(x * 100) / 100;
  return Math.round(x * 1000) / 1000;
}

export function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i += 1) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function atrValue(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 0; i < bars.length; i += 1) {
    const prev = i ? bars[i - 1].close : bars[i].open ?? bars[i].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev)
    ));
  }
  let atr = trs.slice(0, period).reduce((s, n) => s + n, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function swings(bars, radius = 3) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < bars.length - radius; i += 1) {
    const high = bars[i].high;
    const low = bars[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - radius; j <= i + radius; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= high) isHigh = false;
      if (bars[j].low <= low) isLow = false;
    }
    if (isHigh) highs.push({ date: bars[i].date, price: high });
    if (isLow) lows.push({ date: bars[i].date, price: low });
  }
  return { highs, lows };
}

function volumeProfile(bars, bucketCount = 24) {
  const recent = bars.slice(-120);
  const lo = Math.min(...recent.map((r) => r.low));
  const hi = Math.max(...recent.map((r) => r.high));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  const width = (hi - lo) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    low: lo + i * width,
    high: lo + (i + 1) * width,
    vol: 0
  }));
  for (const bar of recent) {
    const mid = (bar.high + bar.low) / 2;
    let idx = Math.floor((mid - lo) / width);
    if (idx < 0) idx = 0;
    if (idx >= bucketCount) idx = bucketCount - 1;
    buckets[idx].vol += bar.volume || 0;
  }
  const total = buckets.reduce((s, b) => s + b.vol, 0);
  if (!total) return null;
  const poc = buckets.reduce((best, b) => (b.vol > best.vol ? b : best), buckets[0]);
  const ranked = [...buckets].sort((a, b) => b.vol - a.vol);
  let acc = 0;
  const keep = new Set();
  for (const b of ranked) {
    keep.add(b);
    acc += b.vol;
    if (acc / total >= 0.7) break;
  }
  const kept = buckets.filter((b) => keep.has(b));
  return {
    poc: (poc.low + poc.high) / 2,
    val: kept[0].low,
    vah: kept[kept.length - 1].high
  };
}

function uniqueSorted(values, last, minGap) {
  const nums = [...new Set(values.filter((n) => Number.isFinite(n)).map((n) => roundPx(n, last)))]
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const out = [];
  for (const n of nums) {
    if (!out.length || Math.abs(n - out[out.length - 1]) >= minGap) out.push(n);
  }
  return out;
}

function pickAbove(sorted, last, count) {
  return sorted.filter((n) => n > last + 1e-9).slice(0, count);
}

function pickBelow(sorted, last, count) {
  return sorted.filter((n) => n < last - 1e-9).slice(-count).reverse();
}

export function trendScore(bars, last, ema50, ema200) {
  let score = 4;
  if (last > ema50) score += 2;
  else score -= 1;
  if (last > ema200) score += 2;
  else score -= 1;
  if (ema50 > ema200) score += 1;
  const ago = bars[bars.length - 21]?.close;
  if (ago && last > ago) score += 1;
  return Math.max(1, Math.min(10, score));
}

export function computeLevels(bars, { lastOverride } = {}) {
  if (!bars?.length || bars.length < 40) {
    return { ok: false, error: '日线不足 40 根，无法算支撑阻力。' };
  }
  const closes = bars.map((r) => r.close);
  const last = lastOverride ?? closes[closes.length - 1];
  const ema50s = emaSeries(closes, 50);
  const ema200s = emaSeries(closes, Math.min(200, closes.length));
  const ema50 = ema50s[ema50s.length - 1];
  const ema200 = ema200s[ema200s.length - 1];
  const atr = atrValue(bars, 14) || last * 0.03;
  const gap = Math.max(atr * 0.35, last * 0.008);
  const { highs, lows } = swings(bars, 3);
  const vp = volumeProfile(bars);
  const win20 = bars.slice(-20);
  const win60 = bars.slice(-60);
  const priorHigh20 = Math.max(...win20.map((r) => r.high));
  const priorLow20 = Math.min(...win20.map((r) => r.low));
  const priorHigh60 = Math.max(...win60.map((r) => r.high));
  const priorLow60 = Math.min(...win60.map((r) => r.low));

  const abovePool = [
    ...highs.slice(-8).map((r) => r.price),
    priorHigh20,
    priorHigh60,
    ema50 > last ? ema50 : null,
    ema200 > last ? ema200 : null,
    vp?.vah
  ];
  const belowPool = [
    ...lows.slice(-8).map((r) => r.price),
    priorLow20,
    priorLow60,
    ema50 < last ? ema50 : null,
    ema200 < last ? ema200 : null,
    vp?.val,
    vp?.poc < last ? vp.poc : null
  ];
  const above = pickAbove(uniqueSorted(abovePool, last, gap), last, 2);
  const below = pickBelow(uniqueSorted(belowPool, last, gap), last, 2);
  let r1 = above[0] ?? roundPx(last + atr, last);
  let r2 = above[1] ?? roundPx(r1 + Math.max(atr, last * 0.04), last);
  let s1 = below[0] ?? roundPx(last - atr, last);
  let s2 = below[1] ?? roundPx(s1 - Math.max(atr, last * 0.04), last);
  if (r2 <= r1) r2 = roundPx(r1 + atr, last);
  if (s2 >= s1) s2 = roundPx(s1 - atr, last);
  const sl = roundPx(Math.min(s2 - atr * 0.75, last - atr * 2), last);

  return {
    ok: true,
    last: roundPx(last, last),
    atr: roundPx(atr, last),
    ema50: roundPx(ema50, last),
    ema200: roundPx(ema200, last),
    r2,
    r1,
    s1,
    s2,
    sl,
    poc: vp ? roundPx(vp.poc, last) : null,
    vah: vp ? roundPx(vp.vah, last) : null,
    val: vp ? roundPx(vp.val, last) : null,
    priorHigh20: roundPx(priorHigh20, last),
    priorLow20: roundPx(priorLow20, last),
    priorHigh60: roundPx(priorHigh60, last),
    priorLow60: roundPx(priorLow60, last),
    trend: trendScore(bars, last, ema50, ema200),
    sources: {
      r1: '最近摆动高点 / 20日高 / 密集区上沿 / EMA',
      r2: '更远的前高或第二阻力',
      s1: '最近摆动低点 / 20日低 / 密集区下沿 / EMA',
      s2: '更远的强支撑',
      sl: 'S2 再退 0.75 ATR，与现价 -2 ATR 取更低'
    }
  };
}

export function trimQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 200) return Math.min(50, Math.max(10, Math.round(n / 6 / 10) * 10));
  if (n >= 20) return Math.max(1, Math.floor(n / 5));
  return Math.max(1, Math.floor(n / 2) || 1);
}

export function addQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 200) return Math.min(50, Math.max(10, Math.round(n / 6 / 10) * 10));
  if (n >= 20) return Math.max(1, Math.floor(n / 10) || 1);
  return 1;
}

export function planAction(accountId, position, levels) {
  const qty = Number(position.qty) || 0;
  const cost = Number(position.avgCost ?? position.cost / (qty || 1)) || null;
  const last = levels.last;
  const role = position.role || '';
  const tiny = qty <= 10 || (position.cost != null && Number(position.cost) < 3000);
  const lines = [];

  if (accountId === 'main') {
    if (/待核|观察|碎片/.test(role) || tiny) {
      return {
        action: tiny ? 'TRIM' : 'REVIEW',
        title: tiny ? '碎片仓，优先清理' : '身份/职责待核验',
        detail: '主账户不为每天有动作而交易。小仓或未核验名字先处理，不按这张图加仓。',
        orders: tiny && qty ? [`现价附近清掉 ${qty} 股`] : []
      };
    }
    if (last <= levels.sl) {
      return {
        action: 'REVIEW',
        title: '跌到趋势破坏区，先问逻辑',
        detail: `现价 ${last} 低于失效 ${levels.sl}。主账户不做机械清仓；问 2–3 年逻辑还在不在。`,
        orders: [`跌破 ${levels.sl} 停止加仓`, '逻辑破坏再 EXIT，不自动市价出清']
      };
    }
    if (last >= levels.r1) {
      const q = trimQty(qty);
      return {
        action: 'TRIM',
        title: '到第一减仓区',
        detail: `现价靠近 R1 ${levels.r1}。按持仓 ${qty} 股、成本 ${cost ?? '—'} 给减仓，不是统一 +5%。`,
        orders: q ? [`$${levels.r1} 以上减 ${q} 股`] : []
      };
    }
    if (last <= levels.s2) {
      const q = addQty(qty);
      return {
        action: 'ADD',
        title: '到强支撑 / 核心补仓区',
        detail: `现价靠近 S2 ${levels.s2}，仍高于失效 ${levels.sl}。补仓数量按现仓，不是统一 -10%。`,
        orders: q ? [`$${levels.s2} 以下买 ${q} 股`, `跌破 ${levels.sl} 停止加仓`] : []
      };
    }
    if (last <= levels.s1) {
      return {
        action: 'WAIT',
        title: '第一观察区',
        detail: `现价在 S1 ${levels.s1} 附近。先看是否站稳，不急着补。`,
        orders: [`$${levels.s2} 以下再考虑补仓`, `跌破 ${levels.sl} 停止加仓`]
      };
    }
    return {
      action: 'HOLD',
      title: '维持',
      detail: '没有逻辑破坏，主账户默认不交易。',
      orders: cost != null ? [`成本 $${cost} · 现仓 ${qty} 股`] : [`现仓 ${qty} 股`]
    };
  }

  if (last <= levels.sl) {
    return {
      action: 'SELL',
      title: '打穿失效，止损及时',
      detail: `现价 ${last} ≤ ${levels.sl}。战术/Agentic 止损必须及时，不要改成长期投资。`,
      orders: qty ? [`跌破 ${levels.sl} 清掉 ${qty}`] : []
    };
  }
  if (last >= levels.r1) {
    const q = trimQty(qty);
    return {
      action: 'TRIM',
      title: '到阻力，先减',
      detail: `R1 ${levels.r1}。止盈可以慢，但到阻力可以减。`,
      orders: q ? [`$${levels.r1} 以上减 ${q}`] : []
    };
  }
  return {
    action: 'HOLD',
    title: '维持，盯失效',
    detail: `失效 ${levels.sl}。没有触线就不要编造买卖。`,
    orders: [`跌破 ${levels.sl} 走`]
  };
}

function px(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.round(Number(n) * 100) / 100;
}

/** 给海报用的说明：阻力/支撑含义 + 按真实股数的操作参考。不是支撑 ±5%–10%。 */
export function levelBriefs(model) {
  const lv = model.levels;
  const qty = Number(model.qty) || 0;
  const cost = model.avgCost;
  const trim = trimQty(qty);
  const add = addQty(qty);
  const main = model.accountId === 'main';
  const last = lv.last;
  const nearR1 = last >= lv.r1 * 0.98;
  const nearS2 = last <= lv.s2 * 1.02 && last > lv.sl;
  return {
    asOf: model.asOf || null,
    emas: model.emaMarks || [],
    resistance: {
      title: '阻力 / 目标（现价上方）',
      lead: `用来评估反弹动能、减仓或突破后如何处理。R1 ${lv.r1}，R2 ${lv.r2}。来源是摆动高点 / 20–60 日前高 / 成交密集区上沿 / EMA，不是整数心理价。`,
      items: [
        { key: 'R1', label: '第一目标', price: lv.r1, text: `近期阻力。到这里可以减，不是必须一次出清。按现仓 ${qty} 股、成本 ${cost ?? '—'}，减 ${trim} 股。` },
        { key: 'R2', label: '第二目标', price: lv.r2, text: '更高阻力 / 第二止盈。先看能否站上 R1，不提前把 R2 当必达。' }
      ]
    },
    support: {
      title: '支撑 / 入场（现价下方）',
      lead: `技术参考，不是精确买点。S1 ${lv.s1} 是第一观察；若失守，下一档看 S2 ${lv.s2}。跌破失效 ${lv.sl} 停止加仓。`,
      items: [
        { key: 'S1', label: '第一支撑', price: lv.s1, text: '近期支撑。回踩先看是否站稳，不急着补。' },
        { key: 'S2', label: '第二支撑', price: lv.s2, text: `更强支撑 / 核心补仓参考。按现仓可补 ${add} 股；仍高于失效才考虑。` }
      ]
    },
    sizing: {
      title: '按你的持仓调整',
      lead: '数量跟现仓和成本走，不要用支撑 ±5%–10% 当买卖带。',
      lines: [
        `现仓 ${qty} 股 · 成本 ${cost ?? '—'} · 现价 ${last}`,
        trim ? `到 R1 ${lv.r1} 以上减 ${trim} 股` : '仓位太小，不按这张图减仓',
        add ? `到 S2 ${lv.s2} 以下买 ${add} 股，跌破 ${lv.sl} 停止加仓` : '仓位太小，不按这张图加仓',
        main
          ? `失效 ${lv.sl}：主账户停止加仓，先问 2–3 年逻辑，不做机械清仓`
          : `失效 ${lv.sl}：战术 / Agentic 打穿则及时清掉 ${qty}`
      ]
    },
    table: [
      { kind: 'res', key: 'R2', label: '第二目标', price: lv.r2, meaning: '更高阻力 / 第二止盈', action: '破 R1 后再盯，不提前追。' },
      {
        kind: 'res',
        key: 'R1',
        label: '第一目标',
        price: lv.r1,
        meaning: '近期阻力 / 第一减仓',
        action: nearR1 && trim ? `现价已靠近，限价减 ${trim} 股` : (trim ? `回升到 ${lv.r1} 以上减 ${trim} 股` : '仓位太小，只观察')
      },
      { kind: 'now', key: 'LAST', label: '现价', price: last, meaning: '当前价', action: model.plan?.title || '对照上下档位' },
      { kind: 'sup', key: 'S1', label: '第一支撑', price: lv.s1, meaning: '近期支撑 / 观察', action: '回踩看是否站稳，不急着补。' },
      {
        kind: 'sup',
        key: 'S2',
        label: '第二支撑',
        price: lv.s2,
        meaning: '更强支撑 / 潜在入场',
        action: nearS2 && add ? `现价已靠近，限价买 ${add} 股` : (add ? `S1 失守后再看，可挂 ${lv.s2} 以下买 ${add} 股` : '不按这张图加仓')
      },
      {
        kind: 'sl',
        key: 'SL',
        label: '失效',
        price: lv.sl,
        meaning: '趋势破坏 / 止损参考',
        action: main ? '停止加仓；逻辑破坏再 EXIT' : `打穿则清掉 ${qty}`
      }
    ]
  };
}

export function buildPosterModel({ account, position, bars, quote, idea = null }) {
  const last = quote?.ok && quote.last != null ? quote.last : bars.at(-1)?.close;
  const levels = computeLevels(bars, { lastOverride: last });
  if (!levels.ok) {
    return {
      ok: false,
      symbol: position.symbol,
      name: position.name || position.symbol,
      error: levels.error
    };
  }
  const plan = planAction(account.id, position, levels);
  const qty = Number(position.qty) || 0;
  const cost = Number(position.avgCost) || (qty ? Number(position.cost || 0) / qty : null);
  const pnl = cost != null && last != null ? (last - cost) * qty : null;
  const pnlPct = cost ? ((last - cost) / cost) * 100 : null;
  const closes = bars.map((row) => row.close);
  const take = 80;
  const ema10 = emaSeries(closes, 10);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, Math.min(200, closes.length));
  const model = {
    ok: true,
    accountId: account.id,
    accountLabel: account.label,
    symbol: position.symbol,
    name: position.name || position.symbol,
    role: position.role || '',
    theme: position.theme || '',
    qty,
    avgCost: cost,
    last: levels.last,
    change: quote?.change ?? null,
    changePct: quote?.changePct ?? null,
    asOf: bars.at(-1)?.date || null,
    pnl,
    pnlPct,
    levels,
    plan,
    idea,
    bars: bars.slice(-take),
    ema20: ema20.slice(-take),
    ema50: ema50.slice(-take),
    ema200: ema200.slice(-take),
    emaMarks: [
      { period: 10, value: px(ema10.at(-1)) },
      { period: 20, value: px(ema20.at(-1)) },
      { period: 50, value: px(ema50.at(-1)) },
      { period: 200, value: px(ema200.at(-1)) }
    ]
  };
  model.brief = levelBriefs(model);
  return model;
}
