/** 0D / 0E 信号。校验通过的期权按报价成交。页面上的单腿参考合约，纸上按 1 张小仓买。 */

const OPTION_BUYS = new Set(['BUY_CALL', 'BUY_PUT']);

export function oracleLongs(rows) {
  return (rows || [])
    .filter((row) => row.market === 'us' && row.direction === 'up' && Number(row.score) >= 2)
    .map((row) => ({ ...row, symbol: String(row.symbol || '').toUpperCase() }))
    .filter((row) => /^[A-Z][A-Z.]{0,4}$/.test(row.symbol))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

/** 九宫偏涨：开/生门 +2、休门 +1。页面上这一组就是 0D 的买入对照。 */
export function qimenLongs(rows) {
  return (rows || [])
    .filter((row) => row.market === 'us' && row.direction === 'up' && Number(row.score) > 0)
    .map((row) => ({ ...row, symbol: String(row.symbol || '').toUpperCase(), source: 'qimen' }))
    .filter((row) => /^[A-Z][A-Z.]{0,4}$/.test(row.symbol))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

/** 卦象关注名单里的偏涨。这张名单本身就是 0D 的买入对照，不再要求股票推荐。 */
export function hexagramLongs(rows) {
  return (rows || [])
    .filter((row) => row.direction === 'up')
    .map((row) => ({
      ...row,
      symbol: String(row.symbol || '').toUpperCase(),
      market: 'us',
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : 2,
      source: 'hex'
    }))
    .filter((row) => /^[A-Z][A-Z.]{0,4}$/.test(row.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** 奇门开门/生门还要当天观察已确认，或推荐是买入/加仓。卦象偏涨不走这里。 */
export function oracleTradable(row, { confirmed = new Set(), buys = new Set() } = {}) {
  const symbol = String(row?.symbol || '').toUpperCase();
  if (!symbol) return null;
  if (confirmed.has(symbol)) return 'watch';
  if (buys.has(symbol)) return 'rec';
  return null;
}

export function oracleExit(row) {
  if (!row) return null;
  if (row.direction === 'down' || Number(row.score) < 0) return 'down';
  return null;
}

/** 权利金相对成本涨到给定比例。缺 Bid 或成本时不算到。 */
export function optionGainExit(avgCost, bid, pct = 0.4) {
  const cost = Number(avgCost);
  const mark = Number(bid);
  if (!(cost > 0) || !(mark > 0) || !(pct > 0)) return false;
  return mark >= cost * (1 + pct) - 1e-9;
}

/** 权利金相对成本跌到给定比例。缺 Bid 或成本时不止损。 */
export function optionLossExit(avgCost, bid, pct = 0.2) {
  const cost = Number(avgCost);
  const mark = Number(bid);
  if (!(cost > 0) || !(mark > 0) || !(pct > 0)) return false;
  return mark <= cost * (1 - pct) + 1e-9;
}

/**
 * 跌 20% 当天平。涨了还在推荐列表里就拿着。
 * 买入日之后不在列表里，并且已经涨了 40%，才止盈。
 * 涨跌用 Bid/Ask 中间价相对成交价，避免买卖价差一买进去就算亏损。
 */
export function optionPaperExit({ avgCost, bid, ask, listed, openedBeforeToday, gainPct = 0.4, lossPct = 0.2 } = {}) {
  const markBid = Number(bid);
  const markAsk = Number(ask);
  const mark = markBid > 0 && markAsk >= markBid ? (markBid + markAsk) / 2 : markBid;
  if (optionLossExit(avgCost, mark, lossPct)) return 'stop';
  if (openedBeforeToday && !listed && optionGainExit(avgCost, mark, gainPct)) return 'tp';
  return null;
}

export function optionLongs(ideas, now = Date.now()) {
  const out = [];
  for (const row of ideas || []) {
    const action = row.action;
    if (!OPTION_BUYS.has(action) || (row.originalAction && row.originalAction !== action) || row.eligible !== true || !row.costs?.ok) continue;
    const legs = row.contract?.legs || [];
    if (legs.length !== 1) continue;
    const leg = legs[0];
    if (['delayed', 'indicative'].includes(leg.quoteMode)) continue;
    if (leg.standard === false || (leg.multiplier != null && Number(leg.multiplier) !== 100)) continue;
    if (leg.type !== (action === 'BUY_CALL' ? 'call' : 'put') || !/^\d{4}-\d{2}-\d{2}$/.test(String(leg.expiration || '')) || !(Number(leg.strike) > 0)) continue;
    const quoteAt = Number(leg.quoteAt);
    if (!(quoteAt > 0) || now - quoteAt > 180000 || now < quoteAt - 5000) continue;
    if (!(Number(leg.bid) > 0) || !(Number(leg.ask) > 0) || Number(leg.ask) < Number(leg.bid)) continue;
    out.push({
      symbol: String(row.symbol || '').toUpperCase(),
      optionType: leg.type,
      expiration: leg.expiration,
      strike: leg.strike,
      bid: Number(leg.bid),
      ask: Number(leg.ask),
      quoteAt,
      quoteMode: leg.quoteMode || null,
      dte: leg.dte,
      debit: row.costs.entryAsk
    });
  }
  return out;
}

/** 扫描页上的单腿参考合约。没有报价时间也可以纸上买 1 张，不把正股价当成期权价。 */
export function optionPaperLongs(ideas) {
  const out = [];
  for (const row of ideas || []) {
    const legs = row.contract?.legs || [];
    if (legs.length !== 1) continue;
    const leg = legs[0];
    if (leg.side && leg.side !== 'buy') continue;
    if (!['call', 'put'].includes(leg.type)) continue;
    if (!(Number(leg.bid) > 0) || !(Number(leg.ask) > 0) || Number(leg.ask) < Number(leg.bid)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(leg.expiration || '')) || !(Number(leg.strike) > 0)) continue;
    const aligned = (row.direction === 'up' && leg.type === 'call') || (row.direction === 'down' && leg.type === 'put');
    if (!aligned) continue;
    if (row.ivLabel === 'extreme') continue;
    const earn = Number(row.earningsInDays);
    if (row.earningsStatus !== 'not-applicable' && Number.isFinite(earn) && earn >= 0 && earn <= Math.max(3, Number(leg.dte) || 0)) continue;
    const mid = (Number(leg.bid) + Number(leg.ask)) / 2;
    if ((Number(leg.ask) - Number(leg.bid)) / mid > 0.25) continue;
    out.push({
      symbol: String(row.symbol || '').toUpperCase(),
      optionType: leg.type,
      expiration: leg.expiration,
      strike: leg.strike,
      bid: Number(leg.bid),
      ask: Number(leg.ask),
      quoteAt: Number(leg.quoteAt) > 0 ? Number(leg.quoteAt) : null,
      quoteMode: leg.quoteMode || null,
      dte: leg.dte,
      aligned,
      reference: true
    });
  }
  return out.sort((a, b) => Number(b.aligned) - Number(a.aligned) || a.symbol.localeCompare(b.symbol));
}

export function sameOptionContract(left, right) {
  const type = String(left?.optionType || left?.right || left?.type || '').toLowerCase();
  return Boolean(
    /^[A-Z][A-Z0-9.-]*$/.test(String(left?.symbol || '').toUpperCase())
    && String(left.symbol).toUpperCase() === String(right?.symbol || '').toUpperCase()
    && /^\d{4}-\d{2}-\d{2}$/.test(String(left?.expiration || ''))
    && left.expiration === right?.expiration
    && Number(left?.strike) > 0
    && Number(left.strike) === Number(right?.strike)
    && ['call', 'put'].includes(type)
    && type === String(right?.optionType || right?.right || right?.type || '').toLowerCase()
  );
}

export function sizeOptionContracts(ask, nav, cash, policy = {}) {
  const premium = Number(ask) * 100;
  if (!(premium > 0) || !(nav > 0)) return null;
  const floor = nav * (policy.cashFloorPct || 0.4);
  const spendable = Math.max(0, cash - floor);
  const budget = Math.min(spendable, nav * 0.03, nav * (policy.maxNamePct || 0.15));
  const qty = Math.floor(budget / premium);
  if (qty < 1) return null;
  return { qty, maxLoss: Number((qty * premium).toFixed(2)) };
}
