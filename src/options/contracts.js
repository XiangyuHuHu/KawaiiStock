import { finiteNumber as num } from '../numbers.js';
import { blackScholes } from './math.js';

export const MODEL_VERSION = 'option-research-v3';
export const isBuy = action => ['BUY_CALL', 'BUY_PUT', 'CALL_SPREAD', 'PUT_SPREAD', 'STRADDLE'].includes(action);
const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

export function quoteIssues(leg) {
  const bid = num(leg?.bid), ask = num(leg?.ask);
  const issues = [];
  if (['delayed', 'indicative'].includes(leg?.quoteMode)) issues.push('延迟或指示性报价，不可作为实时评估报价');
  if (!(bid > 0) || !(ask > 0)) issues.push('缺少有效双边报价（Bid/Ask 必须大于零）');
  else if (ask < bid) issues.push('Bid 高于 Ask，报价异常');
  else if ((ask - bid) / ((ask + bid) / 2) > 0.35) issues.push('买卖价差超过中间价的 35%');
  if (!(num(leg?.volume) > 0 || num(leg?.openInterest) > 0)) issues.push('缺少成交量或持仓量支持');
  return issues;
}

export function legsOf(row) {
  const c = row?.contract;
  if (Array.isArray(c?.legs)) return c.legs;
  if (!c || c.shortStrike != null || c.type === 'straddle') return [];
  return [{ ...c, contractSymbol: c.contractSymbol || c.symbol, side: 'buy', quantity: 1 }];
}

export function structureIssues(legs) {
  const issues = [];
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) return ['缺完整组合腿，不能计算'];
  for (const leg of legs) {
    issues.push(...quoteIssues(leg));
    if (!leg.contractSymbol) issues.push('缺合约唯一代码');
    if (!['call', 'put'].includes(leg.type) || !(num(leg.strike) > 0)) issues.push('合约类型或行权价无效');
    if (!['buy', 'sell'].includes(leg.side) || leg.quantity !== 1) issues.push('仅支持每腿一张的借记组合');
    if (leg.standard !== true || leg.multiplier !== 100) issues.push('交割单位未核实，非标准合约不可自动计算');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.expiration || '')) issues.push('缺到期日');
  }
  if (legs[0].side !== 'buy') issues.push('不支持裸卖期权');
  if (legs.length === 2) {
    const [a, b] = legs;
    if (a.expiration !== b.expiration) issues.push('两腿到期日不同');
    if (a.underlying && b.underlying && a.underlying !== b.underlying) issues.push('两腿标的不同');
    if (a.contractSymbol === b.contractSymbol) issues.push('组合腿重复');
    if (b.side === 'buy') {
      if (a.type === b.type || a.strike !== b.strike) issues.push('双买跨式必须同到期、同执行价、Call + Put');
    } else if (a.type !== b.type || (a.type === 'call' ? a.strike >= b.strike : a.strike <= b.strike)) issues.push('价差腿方向不正确');
  }
  return [...new Set(issues)];
}

export function priceStructure(legs, feePerContract = null) {
  const issues = structureIssues(legs);
  const fee = num(feePerContract);
  if (fee != null && fee < 0) issues.push('手续费不能为负');
  if (issues.length) return { ok: false, issues };
  const sign = leg => leg.side === 'buy' ? 1 : -1;
  const entry = legs.reduce((sum, leg) => sum + sign(leg) * (leg.side === 'buy' ? leg.ask : leg.bid), 0);
  const exit = legs.reduce((sum, leg) => sum + sign(leg) * (leg.side === 'buy' ? leg.bid : leg.ask), 0);
  const mid = legs.reduce((sum, leg) => sum + sign(leg) * (leg.ask + leg.bid) / 2, 0);
  const vertical = legs.length === 2 && legs[1].side === 'sell';
  const width = vertical ? Math.abs(legs[0].strike - legs[1].strike) : null;
  if (!(entry > 0) || (vertical && entry >= width)) return { ok: false, issues: ['净借记不在有效区间，不能形成合理风险预算'] };
  const entryFees = fee == null ? null : fee * legs.length;
  const roundTripFees = fee == null ? null : entryFees * 2;
  const debit = entry * 100;
  const maxPayoff = vertical ? width * 100 : legs.length === 1 && legs[0].type === 'put' ? legs[0].strike * 100 : null;
  const breakCost = entry + (roundTripFees ?? 0) / 100;
  const breakevens = legs.length === 2 && !vertical ? [legs[0].strike - breakCost, legs[0].strike + breakCost] : [legs[0].strike + (legs[0].type === 'call' ? breakCost : -breakCost)];
  return { ok: true, issues: [], multiplier: 100, legs: legs.length, feePerContract: fee, entryFees, roundTripFees,
    entryAsk: round(entry), exitBid: round(exit), mid: round(mid), debit: round(debit), midCost: round(mid * 100),
    entryCost: entryFees == null ? null : round(debit + entryFees), grossMaxLoss: round(debit),
    maxLoss: roundTripFees == null ? null : round(debit + roundTripFees),
    grossMaxProfit: maxPayoff == null ? null : round(maxPayoff - debit),
    maxProfit: maxPayoff == null || roundTripFees == null ? null : round(maxPayoff - debit - roundTripFees),
    uncapped: maxPayoff == null, width, breakevens: breakevens.map(round),
    immediateGrossPnl: round((exit - entry) * 100), stopPlan: round(entry * 0.45),
    takeProfit1: round(vertical ? entry + (width - entry) * 0.45 : entry * 1.7),
    takeProfit2: round(vertical ? entry + (width - entry) * 0.75 : entry * 2.4) };
}

export function scenarioPnl({ legs, spot, movePct = 0, elapsedDays = 0, ivChange = 0, feePerContract = null }) {
  const costs = priceStructure(legs, feePerContract);
  if (!costs.ok) return { ok: false, reason: costs.issues.join('；') };
  if (!(num(spot) > 0) || ![movePct, elapsedDays, ivChange].every(Number.isFinite) || movePct <= -100 || elapsedDays < 0) return { ok: false, reason: '情景参数无效' };
  const futureSpot = spot * (1 + movePct / 100);
  let value = 0;
  for (const leg of legs) {
    if (!(num(leg.iv) > 0) || !(num(leg.dte) >= 0)) return { ok: false, reason: '缺 IV 或剩余期限，无法重估' };
    const remaining = Math.max(0, leg.dte - elapsedDays);
    let mark;
    if (!remaining) mark = Math.max(0, leg.type === 'call' ? futureSpot - leg.strike : leg.strike - futureSpot);
    else {
      const start = blackScholes({ spot, strike: leg.strike, dte: leg.dte, iv: leg.iv, type: leg.type });
      const end = blackScholes({ spot: futureSpot, strike: leg.strike, dte: remaining, iv: Math.max(0.01, leg.iv + ivChange), type: leg.type });
      if (!start || !end) return { ok: false, reason: '模型无法计算' };
      // Anchor the change in model value to the observed midpoint, not an invented fill.
      mark = Math.max(0, (leg.bid + leg.ask) / 2 + end.price - start.price);
      const halfSpread = (leg.ask - leg.bid) / 2;
      mark = Math.max(0, mark + (leg.side === 'buy' ? -halfSpread : halfSpread));
    }
    value += (leg.side === 'buy' ? 1 : -1) * mark;
  }
  value = Math.max(0, costs.width == null ? value : Math.min(costs.width, value));
  const grossPnl = (value - costs.entryAsk) * 100;
  return { ok: true, movePct, elapsedDays, ivChange, exitValue: round(value * 100), grossPnl: round(grossPnl),
    netPnl: costs.roundTripFees == null ? null : round(grossPnl - costs.roundTripFees),
    expired: legs.some(leg => elapsedDays >= leg.dte) };
}

export function structureEv({ legs, spot, forwards, elapsedDays, feePerContract = null }) {
  if (!forwards?.length) return null;
  const values = forwards.filter(Number.isFinite).map(ret => scenarioPnl({ legs, spot, movePct: ret * 100, elapsedDays, feePerContract }));
  if (!values.length || values.some(row => !row.ok)) return null;
  const gross = values.reduce((sum, row) => sum + row.grossPnl, 0) / values.length;
  const net = values[0].netPnl == null ? null : values.reduce((sum, row) => sum + row.netPnl, 0) / values.length;
  return { ev: net == null ? null : net / 100, perGroup: round(net), grossPerGroup: round(gross), samples: values.length,
    assumption: '历史标的样本重估；IV 不变；双边价差及填写的费用；非实际成交或校准盈利概率' };
}

export function scenarioGrid(legs, spot, horizonDays, feePerContract) {
  return [-5, 0, 5, 10].flatMap(movePct => [1 / 24, horizonDays].filter((v, i, a) => a.indexOf(v) === i).flatMap(elapsedDays => [-0.2, 0, 0.2].map(ivChange => scenarioPnl({ legs, spot, movePct, elapsedDays, ivChange, feePerContract }))));
}
