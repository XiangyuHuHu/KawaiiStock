import { quoteIssues, priceStructure, structureEv, scenarioGrid, MODEL_VERSION } from './contracts.js';
import { horizonTarget, sessionCloseMs } from './time.js';
import { atr, blackScholes, clamp, daysBetween, fitPattern, impliedVolFromPrice, mean, realizedVol, sessionVwap } from './math.js';

const WEIGHTS = {
  wave: 0.30,
  vol: 0.20,
  volume: 0.15,
  vwap: 0.10,
  ivRv: 0.15,
  sentiment: 0.10
};

function scoreWave(pat) {
  if (!pat?.ok || !pat.matches) return { score: 20, note: '样本不足，波形一致性无效' };
  const edge = Math.abs((pat.pUp ?? 0.5) - 0.5);
  const sample = clamp(pat.matches / 80, 0.25, 1);
  const score = clamp(28 + edge * 140 * sample, 8, 96);
  return {
    score,
    note: `匹配 ${pat.matches} 次，P(up)=${((pat.pUp || 0) * 100).toFixed(1)}%，样本权重 ${sample.toFixed(2)}`
  };
}

function isIntraday(bars) {
  return String(bars?.[0]?.date || '').includes('T');
}

function scoreVol(intra, daily, pat) {
  const last = intra.at(-1)?.close || daily.at(-1)?.close;
  const py = isIntraday(intra) ? 78 * 252 : 252;
  const atrFast = atr(intra.slice(-80), 14);
  const atrSlow = atr(intra.slice(-200), 14) || atr(daily, 14);
  const rvFast = realizedVol(intra.slice(-78), py);
  const rvSlow = realizedVol(intra.slice(-200), py) || realizedVol(daily.slice(-40), 252);
  const expand = atrFast && atrSlow ? atrFast / atrSlow : 1;
  const rvRatio = rvFast && rvSlow ? rvFast / rvSlow : 1;
  const hist = pat?.pVolExpansion;
  let score = 42;
  if (expand >= 1.15 || rvRatio >= 1.2) score += 18;
  else if (expand >= 1.05) score += 8;
  else if (expand < 0.9) score -= 12;
  if (hist != null) score += (hist - 0.5) * 40;
  return {
    score: clamp(score, 4, 96),
    atrFast,
    atrSlow,
    rvFast,
    rvSlow,
    expand,
    note: `ATR扩张 ${expand.toFixed(2)}x，历史波动继续扩大 ${(hist != null ? (hist * 100).toFixed(0) : '—')}%`,
    last
  };
}

function scoreVolume(intra) {
  const sessionDay = String(intra.at(-1)?.date || '').slice(0, 10);
  const session = intra.filter((row) => String(row.date).slice(0, 10) === sessionDay);
  const last3 = session.slice(-3);
  const base = intra.slice(-42, -3);
  const lastAvg = mean(last3.map((r) => r.volume || 0));
  const baseAvg = mean(base.map((r) => r.volume || 0));
  if (!lastAvg || !baseAvg) return { score: 45, note: '成交量样本不足', ratio: null };
  const ratio = lastAvg / baseAvg;
  const score = clamp(40 + Math.log2(Math.max(ratio, 0.2)) * 18, 8, 92);
  return { score, ratio, note: `近3根量 / 基线 = ${ratio.toFixed(2)}x` };
}

function scoreVwap(intra, direction) {
  const vwap = sessionVwap(intra);
  const last = intra.at(-1)?.close;
  if (!(vwap > 0) || !(last > 0)) return { score: 45, vwap: null, note: '无当日 VWAP', dist: null };
  const dist = (last - vwap) / vwap;
  let score = 50;
  if (direction === 'up') score = dist >= 0 ? 62 + Math.min(dist * 400, 20) : 38 + dist * 200;
  else if (direction === 'down') score = dist <= 0 ? 62 + Math.min(-dist * 400, 20) : 38 - dist * 200;
  else score = 50 - Math.min(Math.abs(dist) * 120, 18);
  return { score: clamp(score, 8, 92), vwap, dist, note: `现价相对 VWAP ${dist >= 0 ? '+' : ''}${(dist * 100).toFixed(2)}%` };
}

function scoreIvRv(iv, expectedRv, impliedMove, expectedMove) {
  if (!(iv > 0) || !(expectedRv > 0)) return { score: 40, label: 'unknown', note: '缺 IV 或预期 RV' };
  const ratio = expectedRv / iv;
  let label = 'fair';
  if (ratio >= 1.15) label = 'cheap';
  else if (ratio <= 0.75) label = 'expensive';
  if (ratio <= 0.55) label = 'extreme';
  const moveGap = expectedMove != null && impliedMove > 0 ? expectedMove / impliedMove : null;
  let score = clamp(48 + (ratio - 1) * 55, 6, 94);
  if (moveGap != null && moveGap < 0.55) score = Math.min(score, 28);
  return {
    score,
    label,
    ratio,
    note: `预期 RV ${(expectedRv * 100).toFixed(0)}% vs IV ${(iv * 100).toFixed(0)}%${moveGap != null ? `；预期波动/隐含波动 ${moveGap.toFixed(2)}` : ''}`
  };
}

function scoreSentiment(sent, direction) {
  if (!sent?.ok || sent.bullishPct == null) {
    return { score: 50, note: '无 Stocktwits 情绪，此项中性', crowded: false };
  }
  const bull = sent.bullishPct;
  let score = 50;
  if (direction === 'up') score = clamp(bull, 8, 92);
  else if (direction === 'down') score = clamp(100 - bull, 8, 92);
  if (sent.crowded) {
    if (direction === 'up' && bull >= 85) score = Math.min(score, 28);
    if (direction === 'down' && bull <= 15) score = Math.min(score, 28);
  }
  return {
    score,
    crowded: Boolean(sent.crowded),
    note: `Bull ${bull.toFixed(0)}%${sent.crowded ? '，拥挤' : ''}`
  };
}

function pickDirection(pat) {
  if (!pat?.ok || pat.pUp == null) return 'none';
  if (pat.pUp >= 0.58) return 'up';
  if (pat.pUp <= 0.42) return 'down';
  return 'none';
}

function directionConviction(pat, direction) {
  const pUp = pat?.pUp ?? 0.5;
  if (direction === 'down') return clamp((1 - pUp) * 100, 1, 99);
  if (direction === 'up') return clamp(pUp * 100, 1, 99);
  return clamp(Math.abs(pUp - 0.5) * 200, 1, 99);
}

function leanLabel(direction) {
  if (direction === 'up') return '看涨';
  if (direction === 'down') return '看跌';
  return '方向不明';
}

function kindLabel(type) {
  if (type === 'put') return 'Put';
  if (type === 'call') return 'Call';
  if (type === 'straddle') return 'Straddle';
  return '';
}

function formatExp(value) {
  return value ? String(value).replaceAll('-', '/') : '';
}

function headlineOf(symbol, direction, contract) {
  const lean = leanLabel(direction);
  if (!contract) return `${symbol} · ${lean}`;
  const exp = formatExp(contract.expiration);
  if (contract.type === 'straddle') {
    return `${symbol} · ${lean} · ${exp} $${contract.callStrike}/${contract.putStrike} Straddle`;
  }
  if (contract.shortStrike) {
    return `${symbol} · ${lean} · ${exp} $${contract.strike}/${contract.shortStrike} ${kindLabel(contract.type)} Spread`;
  }
  return `${symbol} · ${lean} · ${exp} $${contract.strike} ${kindLabel(contract.type)}`;
}

function midOf(row) {
  if (row.mid != null) return row.mid;
  if (row.bid != null && row.ask != null) return (row.bid + row.ask) / 2;
  return row.last ?? row.ask ?? row.bid;
}

function spreadPct(row) {
  const mid = midOf(row);
  if (!(mid > 0) || row.bid == null || row.ask == null) return 1;
  return (row.ask - row.bid) / mid;
}

function dteOf(expiration, asOf) {
  return daysBetween(asOf, expiration);
}

function enrichContract(row, spot, asOf, now) {
  const calendarDte = dteOf(row.expiration, asOf);
  const dte = Math.max(0, (sessionCloseMs(row.expiration) - now) / 86400000);
  const mid = midOf(row);
  const iv = row.iv || impliedVolFromPrice({
    spot,
    strike: row.strike,
    dte: Math.max(dte || 1, 0.5),
    price: mid,
    type: row.type
  });
  const greeks = blackScholes({
    spot,
    strike: row.strike,
    dte: Math.max(dte || 1, 0.5),
    iv: iv || 0.5,
    type: row.type
  });
  return {
    ...row,
    iv: iv ?? row.iv ?? null,
    dte, calendarDte,
    delta: greeks?.delta ?? null,
    gamma: greeks?.gamma ?? null,
    theta: greeks?.theta ?? null,
    vega: greeks?.vega ?? null,
    modelPrice: greeks?.price ?? null,
    spreadPct: spreadPct(row)
  };
}

function liquidEnough(row) {
  return quoteIssues(row).length === 0 && row.calendarDte >= 3 && row.calendarDte <= 45;
}

function tradable(row) {
  return liquidEnough(row) && row.spreadPct != null && row.spreadPct <= 0.15
    && ((Number(row.openInterest) || 0) >= 100 || (Number(row.volume) || 0) >= 20);
}

function preferTradable(rows) {
  const tight = rows.filter(tradable);
  return tight.length ? tight : rows.filter(liquidEnough);
}

function nearestByDelta(rows, target) {
  const ranked = preferTradable(rows)
    .filter((row) => row.delta != null && row.iv != null)
    .map((row) => ({ row, dist: Math.abs(Math.abs(row.delta) - target) }))
    .sort((a, b) => a.dist - b.dist || ((b.row.openInterest || 0) + (b.row.volume || 0)) - ((a.row.openInterest || 0) + (a.row.volume || 0)));
  return ranked[0]?.row || null;
}

function nearestStrike(rows, spot) {
  const ranked = preferTradable(rows)
    .map((row) => ({ row, dist: Math.abs(row.strike - spot) }))
    .sort((a, b) => a.dist - b.dist);
  return ranked[0]?.row || null;
}

function findSpread(legs, longRow, direction) {
  if (!longRow) return null;
  const widthTarget = Math.max(longRow.strike * 0.04, 1);
  const shorts = legs.filter((row) => {
    if (row.type !== longRow.type || row.expiration !== longRow.expiration) return false;
    if (!liquidEnough(row)) return false;
    if (direction === 'up') return row.strike > longRow.strike && row.strike <= longRow.strike + widthTarget * 2.2;
    return row.strike < longRow.strike && row.strike >= longRow.strike - widthTarget * 2.2;
  }).sort((a, b) => Math.abs(Math.abs(a.strike - longRow.strike) - widthTarget) - Math.abs(Math.abs(b.strike - longRow.strike) - widthTarget));
  const shortRow = shorts[0];
  if (!shortRow) return null;
  const debit = longRow.ask - shortRow.bid;
  if (!(debit > 0.05)) return null;
  const width = Math.abs(shortRow.strike - longRow.strike);
  if (debit >= width) return null;
  return {
    structure: longRow.type === 'call' ? 'CALL_SPREAD' : 'PUT_SPREAD',
    long: longRow,
    short: shortRow,
    debit,
    width
  };
}

function impliedMovePct(call, put, spot) {
  if (!call || !put || !(spot > 0)) return null;
  const straddle = (midOf(call) || 0) + (midOf(put) || 0);
  if (!(straddle > 0)) return null;
  return straddle / spot;
}

function annualizeMove(movePct, barsAhead, barsPerDay = 78) {
  if (movePct == null) return null;
  const days = Math.max(barsAhead / barsPerDay, 1 / 78);
  return Math.abs(movePct) * Math.sqrt(252 / days);
}

function buildContractView(contract, extra = {}) {
  if (!contract) return null;
  return {
    ...contract,
    symbol: extra.symbol,
    underlying: extra.underlying,
    type: contract.type,
    expiration: contract.expiration,
    strike: contract.strike,
    bid: contract.bid,
    ask: contract.ask,
    mid: midOf(contract),
    iv: contract.iv,
    delta: contract.delta,
    theta: contract.theta,
    vega: contract.vega,
    gamma: contract.gamma,
    dte: contract.dte,
    volume: contract.volume,
    openInterest: contract.openInterest,
    spreadPct: contract.spreadPct,
    ...extra.more
  };
}

export function decisionFrom({
  direction,
  directionalScore,
  volatilityScore,
  ivLabel,
  evNaked,
  evSpread,
  evStraddle,
  earningsSoon,
  crowded,
  impliedMove,
  expectedAbs,
  horizonDays,
  dte
}) {
  const strongDir = directionalScore >= 62 && direction !== 'none';
  const highVol = volatilityScore >= 58;
  const ivTooHigh = ivLabel === 'expensive' || ivLabel === 'extreme';
  const impliedHorizon = impliedMove != null && dte > 0
    ? impliedMove * Math.sqrt(Math.max(horizonDays, 0.05) / Math.max(dte, horizonDays || 0.05))
    : null;
  const moveCovered = impliedHorizon != null && expectedAbs != null && expectedAbs < impliedHorizon * 0.55;
  const nakedOk = evNaked != null && evNaked.ev > 0 && !moveCovered && !earningsSoon;

  if (evStraddle?.ev > 0 && !strongDir && highVol && !ivTooHigh && !earningsSoon && impliedHorizon != null && expectedAbs != null && expectedAbs > impliedHorizon * 1.05) {
    return { action: 'STRADDLE', reason: '方向不明但预期波动大于同视界隐含波动' };
  }
  if (strongDir && !earningsSoon && ivTooHigh && evSpread?.ev > 0) {
    return { action: direction === 'up' ? 'CALL_SPREAD' : 'PUT_SPREAD', reason: '方向有边，但 IV 太贵，不买裸期权' };
  }
  if (strongDir && highVol && nakedOk && !crowded) {
    return { action: direction === 'up' ? 'BUY_CALL' : 'BUY_PUT', reason: '方向 + 波动扩张 + 期权 EV 为正' };
  }
  if (strongDir && nakedOk && volatilityScore >= 50 && !crowded) {
    return { action: direction === 'up' ? 'BUY_CALL' : 'BUY_PUT', reason: '方向优势足够，期权 EV 为正' };
  }
  if (strongDir && (ivTooHigh || moveCovered || earningsSoon || (evNaked && evNaked.ev <= 0))) {
    return { action: 'NO_TRADE', reason: '股票方向可能对，但这个期权不值得买' };
  }
  return { action: 'NO_TRADE', reason: '没有统计优势，默认不交易' };
}

export function evaluateCov(ctx) {
  const {
    symbol,
    asOf,
    last,
    intra = [],
    daily = [],
    chain,
    sentiment,
    vix
  } = ctx;
  const now = ctx.now || Date.now();
  const intraForPattern = intra.length >= 200;
  const intraMode = intraForPattern;
  const bars = intraForPattern ? intra : daily;
  const lastPx = bars.at(-1)?.close;
  const atrN = atr(bars.slice(-48), 14);
  const thresh = lastPx && atrN
    ? clamp(atrN / lastPx * 0.35, intraMode ? 0.0015 : 0.004, intraMode ? 0.012 : 0.02)
    : (intraMode ? 0.003 : 0.008);
  const horizon = intraMode ? 12 : 3;
  const pat = fitPattern(bars, { length: 8, horizon, thresh, sameSession: intraMode });
  const direction = pickDirection(pat);
  const wave = scoreWave(pat);
  const vol = scoreVol(intra.length >= 30 ? intra : daily, daily, pat);
  const volume = scoreVolume(intra.length >= 20 ? intra : daily);
  const vwap = scoreVwap(intra.length >= 12 ? intra : daily, direction);
  const expectedAbs = pat.avgAbs;
  const expectedRv = annualizeMove(expectedAbs, horizon, intraMode ? 78 : 1);
  const spot = last || vol.last || daily.at(-1)?.close;
  const asOfDay = asOf || new Date().toISOString().slice(0, 10);

  const calls = (chain?.calls || []).map((row) => enrichContract(row, spot, asOfDay, now));
  const puts = (chain?.puts || []).map((row) => enrichContract(row, spot, asOfDay, now));
  const atmCall = nearestByDelta(calls, 0.5) || nearestStrike(calls, spot);
  const atmPut = nearestByDelta(puts, 0.5) || nearestStrike(puts, spot);
  const straddlePut = puts.find(row => row.expiration === atmCall?.expiration && row.strike === atmCall?.strike && liquidEnough(row));
  const ivAtm = atmCall?.iv && atmPut?.iv ? (atmCall.iv + atmPut.iv) / 2 : (atmCall?.iv || atmPut?.iv || null);
  const impliedMove = impliedMovePct(atmCall, atmPut, spot);
  const targetAt = horizonTarget(now, intraMode ? '60m' : '3d');
  const horizonDays = targetAt ? (targetAt - now) / 86400000 : null;
  const atmDte = atmCall?.dte ?? atmPut?.dte;
  const impliedAtHorizon = impliedMove != null && atmDte > 0 && horizonDays != null
    ? impliedMove * Math.sqrt(Math.max(horizonDays, 0.05) / Math.max(atmDte, horizonDays, 0.05))
    : null;
  const ivRv = scoreIvRv(ivAtm, expectedRv, impliedAtHorizon, expectedAbs);
  const sent = scoreSentiment(sentiment, direction);

  const directionalScore = directionConviction(pat, direction);
  const volatilityScore = clamp(vol.score, 1, 99);
  const cov = clamp(
    wave.score * WEIGHTS.wave
    + vol.score * WEIGHTS.vol
    + volume.score * WEIGHTS.volume
    + vwap.score * WEIGHTS.vwap
    + ivRv.score * WEIGHTS.ivRv
    + sent.score * WEIGHTS.sentiment,
    1,
    99
  );

  const longType = direction === 'down' || (direction === 'none' && (pat.pUp ?? 0.5) < 0.5)
    ? 'put'
    : 'call';
  const longLeg = longType === 'put' ? atmPut : atmCall;
  const earningsNotApplicable = chain?.earnings?.status === 'not-applicable';
  const earningsInDays = chain?.earnings?.date ? daysBetween(asOfDay, chain.earnings.date) : chain?.earningsTs
    ? Math.floor((chain.earningsTs * 1000 - (ctx.now || Date.now())) / 86400000) : null;
  const earningsKnown = earningsNotApplicable || (Number.isFinite(earningsInDays) && earningsInDays >= 0);
  const earningsSoon = !earningsNotApplicable && earningsKnown && earningsInDays <= Math.max(3, horizonDays || 0);
  const fee = ctx.feePerContract ?? null;
  const leg = (row, side = 'buy') => row ? { ...row, underlying: symbol, side, quantity: 1 } : null;
  const spread = findSpread(longType === 'call' ? calls : puts, longLeg, longType === 'put' ? 'down' : 'up');
  const singleLegs = longLeg ? [leg(longLeg)] : [];
  const spreadLegs = spread ? [leg(spread.long), leg(spread.short, 'sell')] : [];
  const straddleLegs = atmCall && straddlePut ? [leg(atmCall), leg(straddlePut)] : [];
  const estimate = legs => horizonDays == null ? null : structureEv({ legs, spot, forwards: pat.forwards, elapsedDays: horizonDays, feePerContract: fee });
  const evNaked = estimate(singleLegs), evSpread = estimate(spreadLegs), evStraddle = estimate(straddleLegs);

  const decided = decisionFrom({
    direction,
    directionalScore,
    volatilityScore,
    ivLabel: ivRv.label,
    evNaked,
    evSpread,
    evStraddle,
    earningsSoon,
    crowded: sent.crowded,
    impliedMove,
    expectedAbs,
    horizonDays,
    dte: longLeg?.dte ?? chain?.dte
  });

  const tempting = Boolean(
    decided.action === 'NO_TRADE'
    && direction !== 'none'
    && directionalScore >= 58
    && (ivRv.label === 'expensive' || ivRv.label === 'extreme' || earningsSoon || sent.crowded || (evNaked && evNaked.ev <= 0))
  );

  const selectedLegs = decided.action === 'STRADDLE' ? straddleLegs : decided.action.includes('SPREAD') ? spreadLegs : singleLegs;
  const costs = priceStructure(selectedLegs, fee);
  const selectedEv = decided.action === 'STRADDLE' ? evStraddle : decided.action.includes('SPREAD') ? evSpread : evNaked;
  const first = selectedLegs[0];
  const contract = first ? buildContractView(first, { symbol: first.contractSymbol, underlying: symbol, more: {
    legs: selectedLegs, role: decided.action === 'NO_TRADE' ? 'reference' : 'research',
    type: decided.action === 'STRADDLE' ? 'straddle' : first.type,
    shortStrike: selectedLegs[1]?.side === 'sell' ? selectedLegs[1].strike : null,
    callStrike: decided.action === 'STRADDLE' ? first.strike : null,
    putStrike: decided.action === 'STRADDLE' ? selectedLegs[1]?.strike : null,
    bid: costs.ok ? costs.exitBid : null, ask: costs.ok ? costs.entryAsk : null, mid: costs.ok ? costs.mid : null
  } }) : null;
  const structure = decided.action;
  const maxRisk = costs.ok ? costs.maxLoss : null;
  const takeProfit1 = costs.ok ? costs.takeProfit1 : null, takeProfit2 = costs.ok ? costs.takeProfit2 : null;
  const alternative = null;
  const optionEv = selectedEv?.ev;
  const optionEvLabel = optionEv == null ? 'Unclear' : optionEv > 0 ? 'Positive' : 'Negative';
  const notes = ['只读研究；买腿按 Ask、卖腿按 Bid；报价不是成交保证', 'EV 为历史标的样本的模型重估，非真实期权回测或盈利概率', '情景采用欧式模型价格变化，无股息和提前行权；IV 可变，不能代替真实报价'];
  if (!earningsKnown) notes.push('未来财报时间未核实');
  else if (earningsSoon) notes.push('临近财报，IV 回落风险');
  if (fee == null) notes.push('未填写手续费，净收益及预算数量不可评估');
  if (!pat.ok) notes.push('独立历史样本不足');
  if (!chain?.ok) notes.push(chain?.error || '无期权链');
  else if (chain.expirationChoice) notes.push(chain.expirationChoice);
  const alternatives = [
    { action: longType === 'put' ? 'BUY_PUT' : 'BUY_CALL', legs: singleLegs, ev: evNaked },
    { action: spread?.structure || 'SPREAD', legs: spreadLegs, ev: evSpread },
    { action: 'STRADDLE', legs: straddleLegs, ev: evStraddle }
  ].map(row => ({ ...row, costs: priceStructure(row.legs, fee) }));

  const failPrice = direction === 'up'
    ? (vwap.vwap != null ? vwap.vwap * 0.985 : spot * 0.97)
    : (vwap.vwap != null ? vwap.vwap * 1.015 : spot * 1.03);

  return {
    symbol,
    strategyId: 'cov',
    modelVersion: MODEL_VERSION, costs, alternatives, targetAt, horizonDays,
    evEstimate: selectedEv,
    scenarios: horizonDays == null ? [] : scenarioGrid(selectedLegs, spot, horizonDays, fee),
    last: spot,
    cov: Number(cov.toFixed(1)),
    directionalScore: Number(directionalScore.toFixed(1)),
    volatilityScore: Number(volatilityScore.toFixed(1)),
    direction,
    pUp: pat.pUp,
    pVolExpansion: pat.pVolExpansion,
    patternMatches: pat.matches,
    pattern: pat.current,
    horizon: intraMode ? '60m' : '3d',
    avgUp: pat.avgUp,
    avgDown: pat.avgDown,
    expectedMovePct: expectedAbs,
    impliedMovePct: impliedMove,
    ivAtm,
    rv: vol.rvFast,
    ivLabel: ivRv.label,
    vix: Number(vix?.last) > 0 && vix?.ok !== false ? Number(vix.last) : (Number(vix) > 0 ? Number(vix) : 'unknown'),
    sentiment: sentiment?.ok ? {
      bullishPct: sentiment.bullishPct,
      watchers: sentiment.watchers,
      crowded: sentiment.crowded
    } : null,
    earningsInDays, earningsStatus: earningsNotApplicable ? 'not-applicable' : chain?.earnings?.status || 'unknown',
    components: {
      wave: { weight: WEIGHTS.wave, ...wave },
      vol: { weight: WEIGHTS.vol, score: vol.score, note: vol.note },
      volume: { weight: WEIGHTS.volume, ...volume },
      vwap: { weight: WEIGHTS.vwap, score: vwap.score, vwap: vwap.vwap, note: vwap.note },
      ivRv: { weight: WEIGHTS.ivRv, ...ivRv },
      sentiment: { weight: WEIGHTS.sentiment, ...sent }
    },
    action: decided.action,
    reason: decided.reason,
    tempting,
    temptingReason: tempting ? decided.reason : null,
    lean: leanLabel(direction),
    kind: kindLabel(contract?.type),
    headline: headlineOf(symbol, direction, contract),
    contractRole: contract?.role || (decided.action === 'NO_TRADE' ? 'reference' : 'order'),
    contract,
    structure,
    optionEv: optionEv == null ? null : Number(optionEv.toFixed(3)),
    optionEvLabel,
    optionEvWinRate: null,
    maxRisk: maxRisk == null ? null : Number(maxRisk.toFixed(2)),
    stop: costs.ok ? costs.stopPlan : null,
    failPrice: failPrice == null ? null : Number(Number(failPrice).toFixed(2)),
    takeProfit1: takeProfit1 == null ? null : Number(takeProfit1.toFixed(2)),
    takeProfit2: takeProfit2 == null ? null : Number(takeProfit2.toFixed(2)),
    entry: direction === 'up'
      ? `${symbol} 站上 ${vwap.vwap ? vwap.vwap.toFixed(2) : spot?.toFixed?.(2)}`
      : direction === 'down'
        ? `${symbol} 跌破 ${vwap.vwap ? vwap.vwap.toFixed(2) : spot?.toFixed?.(2)}`
        : '无入场',
    alternative,
    notes,
    source: {
      intraBars: intra.length,
      dailyBars: daily.length,
      chain: chain?.ok ? chain.source : null,
      expiration: chain?.expiration || null,
      dte: chain?.dte ?? longLeg?.dte ?? null
    }
  };
}
