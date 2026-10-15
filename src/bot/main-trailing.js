/** 主账户权益观察：只给建议。研究默认，不是实盘授权，也不生成股数。 */

export const MAIN_TRAILING_PARAMS = {
  label: 'research-defaults',
  liveTradingAuthority: false,
  accountSizeUsd: [10000, 15000],
  accountSizeNote: 'Research defaults for a ~10k-15k self-directed book. Not live trading authority.',
  rDefinition: 'entry - invalidation',
  trim2R: { r: 2, pct: [0.2, 0.25] },
  trim3R: { r: 3, pct: [0.2, 0.3] },
  combinedOpenTrimPct: [0.4, 0.55],
  remainingCorePct: [0.45, 0.6],
  kByVolClass: {
    growth: { k: 2.5, compare: [2.5, 3] },
    cycle: { k: 2.5, compare: [2.5, 3] },
    event: { k: 3, compare: [3, 3.5] },
    'high-vol': { k: 3, compare: [3, 3.5] }
  },
  hwmBandsPct: { normalBelow: 6, reduceBelow: 15, contractAt: 15 },
  themeReferencePct: [35, 45],
  nameReferencePct: { growth: [8, 12], event: [4, 8] }
};

export const MAIN_TRAILING_SCOPE = {
  equityBook: '7811',
  equityBookLabel: '主账户权益',
  wealthEquityBookLast4: '3469',
  excluded: ['7983'],
  note: '7811/主账户权益 only. Wealth equity book last4 3469 is an observer label. 7983 options are excluded. Thresholds are research defaults, not live trading authority.'
};

const DETAILS = {
  'invalidation-breach': '现价触及或跌破入场失效价，观察建议 EXIT',
  'stop-breach': '现价触及或跌破已记录止损，观察建议 EXIT',
  'atr-trail-breach': '现价触及或跌破 ATR 追踪线，观察建议 EXIT',
  '2r-trim': '浮盈达到 +2R，参考兑现 20%–25%',
  '3r-second-tranche': '浮盈达到 +3R，且已做过 +2R 减仓，再参考兑现 20%–30%',
  '3r-combined': '浮盈达到 +3R，且尚未做 +2R 减仓，参考合并兑现 40%–55%（动作码 TRIM_50）',
  '2r-deferred-trend-healthy': '已到 +2R，调用方标明趋势健康，参考允许暂缓',
  '2r-already-trimmed': '+2R 减仓已标记完成，未到 +3R',
  'below-2r': '未到 +2R，观察建议继续持有',
  'trail-inputs-missing': '缺少 ATR 或最高收盘，追踪线空着；R 倍数仍可参考',
  'missing-inputs': '缺少持仓、成本或现价，不编造股数',
  'non-positive-r': 'R 不是正的每股价差，不能用 R 倍数',
  'equity-long-only': '只观察主账户多头权益',
  'rebuy-down-20-alone': '不能只因相对卖出价下跌约 20% 就回补',
  'rebuy-needs-setup': '回补需要趋势回调、整理突破或恐慌修复',
  'flat-no-setup': '没有持仓，也没有合格回补条件'
};

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  const n = num(value);
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function last4(value) {
  return String(value || '').replace(/\D/g, '').slice(-4);
}

function hasTrailingShape(row) {
  if (!row || typeof row !== 'object') return false;
  return ['avgCost', 'invalidation', 'atr14', 'peakClose', 'theme'].every((key) => row[key] != null && row[key] !== '');
}

export function isMainTrailingInput(input = {}, routine = '') {
  const account = String(input.account || input.accountId || '').trim().toLowerCase();
  const book = last4(input.accountLast4);
  const routineName = String(routine || input.routine || '').trim().toLowerCase();
  if (account === '7983' || account === 'agentic' || book === '7983' || routineName.includes('7983')) return false;
  if (account === 'main' || account === '7811' || account === '3469' || account === 'main-equity') return true;
  if (book === '7811' || book === '3469') return true;
  if (routineName === 'main-trailing' || routineName.startsWith('main-trailing')) return true;
  const rows = input.positions || input.holdings || [];
  return rows.some(hasTrailingShape);
}

export function volClassOf(row) {
  const raw = String(row.volClass || row.volatilityClass || row.vol || '').trim().toLowerCase();
  if (/high[-_\s]?vol|elastic/.test(raw)) return 'high-vol';
  if (raw.includes('event')) return 'event';
  if (raw.includes('cycle')) return 'cycle';
  return 'growth';
}

export function resolveK(row) {
  const volClass = volClassOf(row);
  const spec = MAIN_TRAILING_PARAMS.kByVolClass[volClass];
  const given = num(row.k ?? row.atrK);
  if (given != null && given >= 2.5 - 1e-9 && given <= 3.5 + 1e-9) {
    return { volClass, k: given, kCompare: spec.compare.slice(), kSource: 'input', kIgnored: null };
  }
  return {
    volClass,
    k: spec.k,
    kCompare: spec.compare.slice(),
    kSource: 'research-default',
    kIgnored: given == null ? null : 'outside-2.5-3.5'
  };
}

function entryOf(row) {
  return num(row.avgCost ?? row.averageCost ?? row.entry);
}

function invalidationOf(row) {
  return num(row.invalidation ?? row.invalidationPrice);
}

function lastOf(row) {
  return num(row.last ?? row.price ?? row.mark);
}

function prevStopOf(row) {
  return num(row.stop ?? row.stopPrice ?? row.stop_price);
}

function themeOf(row) {
  const theme = String(row.theme || '').trim();
  return theme || null;
}

export function suggestedTrail(row, k) {
  const peak = num(row.peakClose);
  const atr = num(row.atr14);
  const prev = prevStopOf(row);
  if (!(peak > 0) || !(atr > 0) || !(k > 0)) {
    return {
      prevStop: prev == null ? null : round(prev, 4),
      rawTrail: null,
      suggestedTrailStop: null,
      trailReady: false
    };
  }
  const raw = peak - k * atr;
  const stop = prev == null ? raw : Math.max(prev, raw);
  return {
    prevStop: prev == null ? null : round(prev, 4),
    rawTrail: round(raw, 4),
    suggestedTrailStop: round(stop, 4),
    trailReady: true
  };
}

function nameWeight(row, nav, volClass) {
  const mv = num(row.marketValue);
  const cap = volClass === 'event' || volClass === 'high-vol'
    ? MAIN_TRAILING_PARAMS.nameReferencePct.event
    : MAIN_TRAILING_PARAMS.nameReferencePct.growth;
  if (mv == null || !(nav > 0)) {
    return {
      nameWeightPct: null,
      nameWeightReferencePct: cap.slice(),
      nameWeightAboveReference: false,
      nameWeightAboveCap: false
    };
  }
  const nameWeightPct = round(Math.abs(mv) / nav * 100, 4);
  return {
    nameWeightPct,
    nameWeightReferencePct: cap.slice(),
    nameWeightAboveReference: nameWeightPct > cap[0],
    nameWeightAboveCap: nameWeightPct > cap[1]
  };
}

function trimmed2R(row) {
  if (row.trimmed2R === true || row.trimmedAt2R === true) return true;
  return Array.isArray(row.trims) && row.trims.some((item) => String(item).toLowerCase() === '2r');
}

function rebuySetup(row) {
  const raw = String(row.rebuy ?? row.setup ?? row.rebuySetup ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!raw) {
    const drop = num(row.dropFromExitPct ?? row.downFromSalePct ?? row.dropPct);
    if (drop != null && drop <= -20) return { setup: null, reason: 'rebuy-down-20-alone' };
    return { setup: null, reason: 'flat-no-setup' };
  }
  if (raw === 'down-20' || raw === 'down20' || raw === 'price-only' || raw === 'dip-20') {
    return { setup: null, reason: 'rebuy-down-20-alone' };
  }
  if (raw.includes('panic')) return { setup: 'panic-recovery', reason: null };
  if (raw.includes('breakout') || raw.includes('base-break')) return { setup: 'breakout', reason: null };
  if (raw.includes('trend') || raw.includes('pullback')) return { setup: 'trend', reason: null };
  return { setup: null, reason: 'rebuy-needs-setup' };
}

function wantsRebuyAdd(row) {
  if (row.rebuyAdd === true) return true;
  const tranche = num(row.rebuyTranche ?? row.tranche);
  if (tranche != null && tranche >= 2) return true;
  const stage = String(row.rebuyStage || '').toLowerCase();
  return stage === 'add' || stage === 'rebuy-add';
}

function shell(fields) {
  return {
    symbol: fields.symbol,
    theme: fields.theme ?? null,
    volClass: fields.volClass ?? null,
    qty: fields.qty ?? null,
    entry: fields.entry ?? null,
    invalidation: fields.invalidation ?? null,
    last: fields.last ?? null,
    r: fields.r ?? null,
    unrealizedR: fields.unrealizedR ?? null,
    k: fields.k ?? null,
    kCompare: fields.kCompare ?? null,
    kSource: fields.kSource ?? null,
    kIgnored: fields.kIgnored ?? null,
    prevStop: fields.prevStop ?? null,
    rawTrail: fields.rawTrail ?? null,
    suggestedTrailStop: fields.suggestedTrailStop ?? null,
    suggestedAction: fields.suggestedAction,
    reason: fields.reason,
    detail: fields.detail || DETAILS[fields.reason] || '',
    referenceTrimPct: fields.referenceTrimPct ?? null,
    referenceTranche: fields.referenceTranche ?? null,
    setup: fields.setup ?? null,
    orderQty: null,
    missing: fields.missing || [],
    nameWeightPct: fields.nameWeightPct ?? null,
    nameWeightReferencePct: fields.nameWeightReferencePct ?? null,
    nameWeightAboveReference: Boolean(fields.nameWeightAboveReference),
    nameWeightAboveCap: Boolean(fields.nameWeightAboveCap),
    observationOnly: true
  };
}

function suggestRebuy(base) {
  const { setup, reason } = rebuySetup(base.row);
  if (!setup) {
    return shell({
      ...base,
      suggestedAction: 'NO_TRADE',
      reason,
      setup: null
    });
  }
  if (wantsRebuyAdd(base.row)) {
    return shell({
      ...base,
      suggestedAction: 'REBUY_ADD',
      reason: 'rebuy-add',
      detail: `合格回补（${setup}）已起步，参考再补一档，不计算股数`,
      referenceTranche: 'next-third',
      setup
    });
  }
  return shell({
    ...base,
    suggestedAction: 'REBUY_1_3',
    reason: 'rebuy-first-third',
    detail: `合格回补（${setup}），参考先试计划仓位的 1/3，不计算股数`,
    referenceTranche: '1/3',
    setup
  });
}

export function suggestMainPosition(row = {}, context = {}) {
  const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
  const qty = num(row.qty ?? row.quantity);
  const side = String(row.side || (qty != null && qty < 0 ? 'short' : 'long')).toLowerCase();
  const instrument = String(row.instrument || row.type || 'stock').toLowerCase();
  const entry = entryOf(row);
  const invalidation = invalidationOf(row);
  const last = lastOf(row);
  const kSpec = resolveK(row);
  const trail = suggestedTrail(row, kSpec.k);
  const theme = themeOf(row);
  const r = entry != null && invalidation != null ? round(entry - invalidation, 4) : null;
  const unrealizedRaw = r > 0 && last != null ? (last - entry) / r : null;
  const weight = nameWeight(row, num(context.nav), kSpec.volClass);
  const missing = [];
  if (!(num(row.atr14) > 0)) missing.push('atr14');
  if (!(num(row.peakClose) > 0)) missing.push('peakClose');
  if (!theme) missing.push('theme');
  const base = {
    row,
    symbol,
    theme,
    volClass: kSpec.volClass,
    qty: qty == null ? null : round(qty, 4),
    entry,
    invalidation,
    last,
    r,
    unrealizedR: unrealizedRaw == null ? null : round(unrealizedRaw, 4),
    ...kSpec,
    ...trail,
    ...weight,
    missing
  };

  if (!symbol) return shell({ ...base, suggestedAction: 'NO_TRADE', reason: 'missing-inputs', missing: [...missing, 'symbol'] });
  if (instrument.includes('option') || side === 'short' || (qty != null && qty < 0)) {
    return shell({ ...base, suggestedAction: 'NO_TRADE', reason: 'equity-long-only' });
  }
  if (!(qty > 0)) {
    if (qty == null && row.rebuy == null && row.setup == null && row.rebuySetup == null && row.rebuyAdd == null) {
      return shell({ ...base, suggestedAction: 'NO_TRADE', reason: 'missing-inputs', missing: [...missing, 'qty'] });
    }
    return suggestRebuy(base);
  }
  if (entry != null && invalidation != null && entry > invalidation && last != null && last <= invalidation) {
    return shell({ ...base, suggestedAction: 'EXIT', reason: 'invalidation-breach' });
  }
  if (last != null && trail.prevStop != null && last <= trail.prevStop) {
    return shell({ ...base, suggestedAction: 'EXIT', reason: 'stop-breach' });
  }
  if (!(entry > 0) || invalidation == null || last == null) {
    const absent = [...missing];
    if (!(entry > 0)) absent.push('avgCost');
    if (invalidation == null) absent.push('invalidation');
    if (last == null) absent.push('last');
    return shell({ ...base, suggestedAction: 'NO_TRADE', reason: 'missing-inputs', missing: absent });
  }
  if (!(r > 0)) return shell({ ...base, suggestedAction: 'NO_TRADE', reason: 'non-positive-r' });
  if (trail.trailReady && trail.suggestedTrailStop != null && last <= trail.suggestedTrailStop) {
    return shell({ ...base, suggestedAction: 'EXIT', reason: 'atr-trail-breach' });
  }
  const trimmed = trimmed2R(row);
  if (unrealizedRaw + 1e-9 >= 3) {
    if (trimmed) {
      return shell({
        ...base,
        suggestedAction: 'TRIM_25',
        reason: '3r-second-tranche',
        referenceTrimPct: MAIN_TRAILING_PARAMS.trim3R.pct.slice()
      });
    }
    return shell({
      ...base,
      suggestedAction: 'TRIM_50',
      reason: '3r-combined',
      referenceTrimPct: MAIN_TRAILING_PARAMS.combinedOpenTrimPct.slice()
    });
  }
  if (unrealizedRaw + 1e-9 >= 2) {
    if (trimmed) return shell({ ...base, suggestedAction: 'HOLD', reason: '2r-already-trimmed' });
    if (row.trendHealthy === true && row.overheated !== true) {
      return shell({ ...base, suggestedAction: 'HOLD', reason: '2r-deferred-trend-healthy' });
    }
    return shell({
      ...base,
      suggestedAction: 'TRIM_25',
      reason: '2r-trim',
      referenceTrimPct: MAIN_TRAILING_PARAMS.trim2R.pct.slice()
    });
  }
  if (!trail.trailReady) return shell({ ...base, suggestedAction: 'HOLD', reason: 'trail-inputs-missing' });
  return shell({ ...base, suggestedAction: 'HOLD', reason: 'below-2r' });
}

export function themeWeights(rows, nav) {
  const buckets = new Map();
  let partial = false;
  let valued = 0;
  for (const row of rows || []) {
    const qty = num(row.qty ?? row.quantity);
    const mv = num(row.marketValue);
    if (mv == null) {
      if (qty > 0) partial = true;
      continue;
    }
    const label = themeOf(row) || 'unspecified';
    const key = label.toLowerCase();
    const abs = Math.abs(mv);
    valued += abs;
    const bucket = buckets.get(key) || { theme: label, marketValue: 0 };
    bucket.marketValue += abs;
    buckets.set(key, bucket);
  }
  const basisNav = num(nav);
  const denom = basisNav > 0 ? basisNav : valued;
  const themeWeightBasis = basisNav > 0 ? 'nav' : (valued > 0 ? 'market-value-sum' : null);
  const weights = [...buckets.values()].map((bucket) => {
    const weightPct = denom > 0 ? round(bucket.marketValue / denom * 100, 4) : null;
    return {
      theme: bucket.theme,
      marketValue: round(bucket.marketValue, 2),
      weightPct,
      referenceCapPct: MAIN_TRAILING_PARAMS.themeReferencePct.slice(),
      aboveReference: weightPct != null && weightPct > 35,
      aboveUpperReference: weightPct != null && weightPct > 45
    };
  }).sort((a, b) => a.theme.localeCompare(b.theme));
  return {
    themeWeights: weights,
    themeWeightSumPct: weights.length ? round(weights.reduce((sum, row) => sum + (row.weightPct || 0), 0), 4) : null,
    themeWeightBasis,
    themeWeightsPartial: partial,
    themeConcentrationReview: weights.some((row) => row.aboveReference),
    themeMonitorOnly: true
  };
}

export function hwmStatus(input = {}) {
  const nav = num(input.nav ?? input.equity ?? input.accountValue);
  const hwmNav = num(input.hwmNav ?? input.hwm ?? input.peakNav);
  if (!(hwmNav > 0) || nav == null) {
    return {
      nav: nav == null ? null : round(nav, 2),
      hwmNav: hwmNav == null ? null : round(hwmNav, 2),
      hwmDrawdownPct: null,
      hwmBand: null,
      riskMode: null
    };
  }
  const hwmDrawdownPct = round(Math.max(0, (hwmNav - nav) / hwmNav * 100), 4);
  let hwmBand = '0-6';
  let riskMode = 'normal';
  if (hwmDrawdownPct >= 15) {
    hwmBand = '15+';
    riskMode = 'contract';
  } else if (hwmDrawdownPct >= 10) {
    hwmBand = '10-15';
    riskMode = 'reduce';
  } else if (hwmDrawdownPct >= 6) {
    hwmBand = '6-10';
    riskMode = 'reduce';
  }
  return {
    nav: round(nav, 2),
    hwmNav: round(hwmNav, 2),
    hwmDrawdownPct,
    hwmBand,
    riskMode
  };
}

export function assessMainTrailing(input = {}) {
  const rows = input.positions || input.holdings || [];
  const hwm = hwmStatus(input);
  const themes = themeWeights(rows, hwm.nav);
  const positions = rows
    .map((row) => suggestMainPosition(row, { nav: hwm.nav }))
    .filter((row) => row.symbol);
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol) || String(a.suggestedAction).localeCompare(String(b.suggestedAction)));
  const actions = {};
  for (const row of positions) actions[row.symbol] = row.suggestedAction;
  return {
    version: 'main-account-trailing-v1',
    observationOnly: true,
    liveTradingAuthority: false,
    placesOrders: false,
    autoTrim: false,
    researchDefaults: true,
    riskModeChangesAction: false,
    hwmMonitorOnly: true,
    scope: MAIN_TRAILING_SCOPE,
    params: MAIN_TRAILING_PARAMS,
    ...hwm,
    hwmFlowAdjusted: input.hwmFlowAdjusted === true,
    hwmNote: input.hwmFlowAdjusted === true
      ? '使用调用方给出的资金流调整后高水位'
      : '未声明资金流调整。出入金要由调用方先调高水位，这里不推断入金。',
    ...themes,
    positions,
    actions
  };
}

export function trailingActionChanges(current, previous) {
  if (!current || !previous) return [];
  const curr = current.actions || {};
  const prev = previous.mainTrailing?.actions;
  if (!prev) {
    return Object.keys(curr).sort().map((symbol) => ({ symbol, from: null, to: curr[symbol] }));
  }
  const symbols = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const changes = [];
  for (const symbol of [...symbols].sort()) {
    const from = Object.prototype.hasOwnProperty.call(prev, symbol) ? prev[symbol] : null;
    const to = Object.prototype.hasOwnProperty.call(curr, symbol) ? curr[symbol] : null;
    if (from !== to) changes.push({ symbol, from, to });
  }
  return changes;
}
