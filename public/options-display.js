// Display source facts independently of eligibility and portfolio cost calculations.
export function referenceContract(row) {
  const c = row?.contract;
  if (!c) return { legs: [], incomplete: true };
  if (c.legs?.length) return { legs: c.legs, incomplete: false };
  const common = { expiration: c.expiration, quoteAt: null, legacy: true };
  if (c.type === 'straddle') return { incomplete: true, legs: [
    { ...common, side: 'buy', type: 'call', strike: c.callStrike, bid: c.callBid, ask: c.callAsk },
    { ...common, side: 'buy', type: 'put', strike: c.putStrike, bid: c.putBid, ask: c.putAsk }
  ] };
  const first = { ...c, side: 'buy', contractSymbol: c.contractSymbol || c.symbol, legacy: true };
  if (c.shortStrike != null) return { incomplete: true, legs: [first,
    { ...common, side: 'sell', type: c.type, strike: c.shortStrike, bid: c.shortBid, ask: c.shortAsk }
  ] };
  return { legs: [first], incomplete: true };
}

export function actionLabel(action) {
  return ({ BUY_CALL: '买入 Call', BUY_PUT: '买入 Put', CALL_SPREAD: '看涨借记价差', PUT_SPREAD: '看跌借记价差', STRADDLE: '买入跨式', NO_TRADE: '暂不买入' })[action] || '尚未判断';
}

export function assessment(row, { currentModel, fresh, eligible, historicalView } = {}) {
  if (historicalView) return { kind: 'history', label: '历史回看', reason: '以下保留当时记录，不是当前买入判断', evLabel: currentModel ? null : '旧版未算净 EV' };
  if (!currentModel) return { kind: 'history', label: '历史记录 · 待重扫', reason: '旧扫描未按新版组合成本和费用计算，不能代表当前判断', evLabel: '待重算' };
  if (eligible) return { kind: 'candidate', label: actionLabel(row.action), reason: row.reason, evLabel: null };
  const blockers = row.blockers || [];
  if (!fresh) return { kind: 'data', label: '报价待核实', reason: blockers.find(s => /报价|时间缺失|过期/.test(s)) || '报价已过期，须取得可验证时间的新报价', evLabel: row.evEstimate?.perGroup == null ? '未计算' : null };
  const unverified = blockers.find(s => !/净 EV 缺失或不为正|当前不在已核实的美股常规交易时段|超过本轮最多/.test(s));
  if (unverified) return { kind: 'data', label: '条件未齐 · 待评估', reason: unverified, evLabel: row.evEstimate?.perGroup == null ? '未计算' : null };
  if (blockers.some(s => /常规交易时段/.test(s))) return { kind: 'session', label: '非交易时段 · 观察', reason: '等待常规交易时段及新报价后评估', evLabel: row.evEstimate?.perGroup == null ? '未计算' : null };
  if (row.evEstimate?.perGroup == null) return { kind: 'data', label: '数据不足 · 待评估', reason: '尚无完整净 EV 估计，不能判断是否有买入优势', evLabel: '未计算' };
  if (blockers.some(s => /超过本轮最多/.test(s))) return { kind: 'watch', label: '候补观察', reason: '超过本轮最多 3 个候选限制', evLabel: null };
  return { kind: 'no-edge', label: '暂无买入优势', reason: row.reason || '本次评估未通过策略门槛', evLabel: null };
}
