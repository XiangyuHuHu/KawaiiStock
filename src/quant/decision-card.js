import { closedBars } from '../market-time.js';
import { suggestMainPosition } from '../bot/main-trailing.js';
import { baseHighOf } from './indicators.js';
import { assessMtf } from './mtf.js';
import { QUANT_PARAMS, classifyRegime, classifyStage, featuresFromBars } from './regime.js';
import { evaluateReentry, reentryTriggerText } from './reentry.js';
import { relativeStrength, sectorEtfFor } from './relative-strength.js';

export const CARD_ACTIONS = ['HOLD', 'TRIM', 'EXIT', 'REBUY', 'NO_TRADE'];

const FLAGS = {
  version: 'kawaii-quant-v1',
  observationOnly: true,
  liveTrading: false,
  liveTradingAuthority: false,
  placesOrders: false,
  autoTrade7811: false,
  brokerOrders: false,
  researchDefaults: true,
  pendingBacktest: true,
  orderQty: null
};

function coarse(action) {
  if (action === 'TRIM_25' || action === 'TRIM_50') return 'TRIM';
  if (action === 'REBUY_1_3' || action === 'REBUY_ADD') return 'REBUY';
  return CARD_ACTIONS.includes(action) ? action : 'NO_TRADE';
}

function usableDaily(input) {
  const bars = (input.bars || []).filter((bar) => bar?.close > 0);
  if (!input.asOf) return bars;
  const now = input.asOf instanceof Date ? input.asOf : new Date(input.asOf);
  return closedBars(bars, now);
}

function breadthOf(spyBars, qqqBars) {
  const above = (bars) => {
    if (!bars || bars.length < 200) return null;
    const closes = bars.map((bar) => bar.close);
    const ema = closes.reduce((seed, value, index) => {
      if (index === 0) return value;
      const k = 2 / 201;
      return value * k + seed * (1 - k);
    }, closes[0]);
    return closes[closes.length - 1] > ema;
  };
  const spy = above(spyBars);
  const qqq = above(qqqBars);
  if (spy == null && qqq == null) return { state: 'unknown', addsBlocked: false };
  if (spy === false && qqq === false) return { state: 'risk-off', addsBlocked: true };
  if (spy === true && qqq === true) return { state: 'risk-on', addsBlocked: false };
  if (spy == null || qqq == null) return { state: 'partial', addsBlocked: false };
  return { state: 'mixed', addsBlocked: false };
}

function fmt(value) {
  return value == null || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(2);
}

export function buildDecisionCard(input = {}) {
  const symbol = String(input.symbol || input.position?.symbol || '').trim().toUpperCase();
  const daily = usableDaily(input);
  const position = { ...(input.position || {}) };
  const last = position.last ?? position.price ?? (daily.length ? daily[daily.length - 1].close : null);
  if (last != null) position.last = last;
  const features = daily.length ? featuresFromBars(daily) : {};
  const regimePack = daily.length >= 50 ? classifyRegime(features) : { regime: 'unknown', playbook: 'defend', regimeReason: 'indicators-short' };
  const stagePack = classifyStage(features, regimePack.regime);
  const mtf = assessMtf({ daily, weekly: input.weeklyBars, hourly: input.hourlyBars });
  const sectorSymbol = input.sectorSymbol || sectorEtfFor(symbol);
  const rs = relativeStrength({
    bars: daily,
    spyBars: input.spyBars,
    sectorBars: input.sectorBars,
    sectorSymbol
  });
  const breadth = input.breadth || breadthOf(input.spyBars, input.qqqBars);
  const baseHigh = baseHighOf(daily);
  const qty = Number(position.qty ?? position.quantity);
  const row = {
    ...position,
    symbol,
    stage: stagePack.stage,
    exhaustion: stagePack.exhausted === true,
    structureBreak: features.structureBreak === true,
    atr14: position.atr14 ?? features.atr14,
    peakClose: position.peakClose ?? last
  };
  const trailing = symbol ? suggestMainPosition(row, input.context || {}) : null;
  const reentry = evaluateReentry({
    qty: qty > 0 ? qty : 0,
    last,
    ema20: features.ema20,
    ema50: features.ema50,
    atr14: features.atr14,
    baseHigh,
    rs20: rs.excess20,
    rs20Prev: rs.excess20Prev,
    mtfConfirmed: mtf.confirmed,
    regime: regimePack.regime,
    playbook: regimePack.playbook,
    addsBlocked: breadth.addsBlocked,
    dropFromExitPct: input.dropFromExitPct ?? position.dropFromExitPct,
    rebuyAdd: position.rebuyAdd,
    rebuyTranche: position.rebuyTranche
  });
  const held = qty > 0;
  const trailingAction = held ? trailing?.suggestedAction || 'NO_TRADE' : reentry.action;
  const suggestedAction = held ? coarse(trailingAction) : coarse(reentry.action);
  const givebackPct = trailing?.givebackPct ?? null;
  const reasons = [];
  if (regimePack.regime === 'unknown') reasons.push('日线不够，状态机不做方向判断。');
  else reasons.push(`状态 ${regimePack.regime}，允许的剧本是 ${regimePack.playbook}。`);
  if (stagePack.stage) {
    reasons.push(`阶段 ${stagePack.stage}。趋势分 ${stagePack.scores.trend}，衰竭分 ${stagePack.scores.exhaustion}。`);
  }
  reasons.push(`日线 ${mtf.daily}，周线 ${mtf.weekly}，小时 ${mtf.hourly}。${mtf.confirmed ? '多周期确认，回补候选才可以打开。' : '多周期没有确认，不新增。'}`);
  if (mtf.incompleteWeeklyDropped) reasons.push('最后这一周还没走完，没有拿来当周线趋势。');
  if (breadth.state === 'risk-off') reasons.push('SPY 和 QQQ 都在 200 日均线下方，研究默认暂停新回补。');
  if (rs.excess20 == null) reasons.push('没有对齐的 SPY 时，相对强度留空。');
  else reasons.push(`20 日相对 SPY 超额 ${(rs.excess20 * 100).toFixed(1)} 个百分点，分数 ${rs.score}。`);
  if (rs.sector && rs.sectorExcess20 != null) {
    reasons.push(`相对 ${rs.sector} 超额 ${(rs.sectorExcess20 * 100).toFixed(1)} 个百分点。`);
  }
  if (trailing?.suggestedTrailStop != null) reasons.push(`追踪止损 ${fmt(trailing.suggestedTrailStop)}，k=${trailing.k}。`);
  if (givebackPct != null) reasons.push(`峰值浮盈已回吐 ${givebackPct}%。回吐本身不卖。`);
  if (trailing?.rsiIgnored) reasons.push('RSI 高低不单独改变动作。');
  if (trailing?.extensionIgnored) reasons.push('只是涨得多，不单独卖出。');
  if (trailing?.kTightened != null) reasons.push(`衰竭或结构破坏，k 收到 ${trailing.kTightened}。`);
  reasons.push(...(held ? ['持仓动作沿用主账户追踪，不另起一套卖出规则。'] : reentry.reasons));
  reasons.push(reentryTriggerText({ ema20: features.ema20, ema50: features.ema50, baseHigh }));
  const martin = martinSideNote(input.martin);
  if (martin) reasons.push(martin.note);

  return {
    ...FLAGS,
    symbol,
    regime: regimePack.regime,
    playbook: regimePack.playbook,
    regimeReason: regimePack.regimeReason,
    stage: stagePack.stage,
    scores: {
      trend: stagePack.scores.trend,
      exhaustion: stagePack.scores.exhaustion,
      relativeStrength: rs.score
    },
    suggestedAction,
    trailingAction,
    reason: held ? trailing?.reason || null : reentry.reason,
    trailingStop: trailing?.suggestedTrailStop ?? null,
    k: trailing?.k ?? null,
    kVariants: trailing?.kVariants ?? null,
    kTightened: trailing?.kTightened ?? null,
    tightenReason: trailing?.tightenReason ?? null,
    referenceTrimPct: trailing?.referenceTrimPct ?? null,
    givebackPct,
    givebackChangesAction: false,
    givebackWatch: givebackPct != null && givebackPct >= QUANT_PARAMS.givebackWatchPct,
    rsiIgnored: Boolean(trailing?.rsiIgnored),
    extensionIgnored: Boolean(trailing?.extensionIgnored),
    reentryTrigger: reentryTriggerText({ ema20: features.ema20, ema50: features.ema50, baseHigh }),
    reentry,
    relativeStrength: rs,
    breadth,
    mtf,
    levels: {
      trailingStop: trailing?.suggestedTrailStop ?? null,
      ema20: features.ema20 ?? null,
      ema50: features.ema50 ?? null,
      ema200: features.ema200 ?? null,
      baseHigh
    },
    reasons,
    missing: trailing?.missing || [],
    detail: trailing?.detail || reentry.reasons[0] || '',
    ...(martin ? { martin } : {})
  };
}

/** Martin 日报只作并列参考。不改 suggestedAction，也不产生股数。 */
function martinSideNote(martin) {
  if (!martin || typeof martin !== 'object') return null;
  return {
    referenceOnly: true,
    replacesGates: false,
    liveTrading: false,
    placesOrders: false,
    action: martin.action || null,
    stage: martin.stage || null,
    scan: martin.scan ?? null,
    planned_stop: martin.planned_stop ?? null,
    note: 'Martin 建议只并列展示，不改这张卡的动作，也不下单。'
  };
}

export function buildDecisionCards(input = {}) {
  const symbols = (input.symbols || (input.symbol ? [input.symbol] : []))
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean);
  const cards = symbols.map((symbol) => buildDecisionCard({
    ...input,
    symbol,
    bars: input.barsBySymbol?.[symbol] || (String(input.symbol || '').toUpperCase() === symbol ? input.bars : []),
    sectorBars: input.sectorBarsBySymbol?.[symbol] || input.sectorBars,
    sectorSymbol: input.sectorSymbol || sectorEtfFor(symbol),
    position: (input.positions || []).find((row) => String(row.symbol || '').toUpperCase() === symbol)
      || (String(input.position?.symbol || '').toUpperCase() === symbol ? input.position : { symbol })
  }));
  return { ...FLAGS, ok: true, cards };
}
