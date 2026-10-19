import { createHash } from 'node:crypto';
import { finiteNumber as num, instrumentOf } from '../numbers.js';
import { evaluateFreshness } from '../risk/freshness.js';
import { chinaPaperSession, orderMarket, regularPaperSession } from './sessions.js';

export { regularPaperSession } from './sessions.js';

export function orderFingerprint(order) {
  const keys = ['symbol', 'side', 'qty', 'limitPrice', 'price', 'stopPrice', 'maxLoss', 'reduceOnly', 'expiration', 'strike', 'optionType'];
  const value = { instrument: instrumentOf(order.instrument) };
  for (const key of keys) value[key] = order[key] ?? null;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function paperEquityNeedsReference(quote, now = Date.now(), market = 'us') {
  if (!evaluateFreshness({ quoteAt: quote?.quoteAt, last: quote?.last }, now).fresh) return true;
  return market === 'cn' ? !chinaPaperSession(now) : !regularPaperSession(now);
}

function sessionDenial(order, now) {
  const market = orderMarket(order);
  const open = market === 'cn' ? chinaPaperSession(now) : regularPaperSession(now);
  if (open) return null;
  return market === 'cn'
    ? '纸上撮合只在 A 股交易时段运行（北京时间 9:30–11:30、13:00–15:00）'
    : '纸上撮合只在美股常规交易时段运行';
}

/**
 * Broker-side stop replay on daily bars: the first bar after the stop was set whose low touches it
 * fills at min(stop, open), so a gap-down open below the stop fills at the open.
 */
export function brokerStopHit(bars, stop, afterDate, throughDate) {
  const level = num(stop);
  if (!(level > 0)) return null;
  const rows = [...(bars || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const bar of rows) {
    if (!(bar.date > afterDate) || bar.date > throughDate) continue;
    const low = num(bar.low), open = num(bar.open);
    if (low > 0 && low <= level) {
      const fill = open > 0 ? Math.min(level, open) : level;
      return { date: bar.date, stop: level, open, low, reference: fill, price: Number((fill * (1 - 0.0005)).toFixed(4)) };
    }
  }
  return null;
}

/** Long option paper fill uses the contract bid/ask and its own timestamp. Stock last is never a substitute. */
export function paperOptionExecution(order, quote, now = Date.now()) {
  const deny = (code, message) => ({ ok: false, code, message });
  if (['delayed', 'indicative'].includes(order.quoteMode || quote?.quoteMode)) return deny('delayed-quote', '延迟或指示性期权报价不能纸上成交');
  const bid = num(quote?.bid), ask = num(quote?.ask);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return deny('contract-quote-required', '期权缺有效双边报价，不能用正股价格代替');
  if (order.paperReference === true) {
    const buying = ['buy', 'add'].includes(String(order.side || '').toLowerCase());
    if (buying && num(order.qty) !== 1) return deny('reference-size', '参考报价纸上只买 1 张');
    const limit = num(order.limitPrice ?? order.price);
    if (!(limit > 0) || !(num(order.qty) > 0)) return deny('invalid-order', '限价与数量必须为正数');
    const reference = buying ? ask : bid;
    const price = reference * (1 + (buying ? 1 : -1) * 0.0005);
    if ((buying && price > limit) || (!buying && price < limit)) return deny('limit-not-marketable', buying ? '限价未覆盖合约参考 Ask' : '限价高于合约参考 Bid');
    return {
      ok: true, price, referencePrice: reference, slippageBps: 5, fee: 0, quoteAt: quote?.quoteAt ?? null,
      model: buying ? 'paper-option-reference-v1' : 'paper-option-reference-exit-v1',
      feeNote: buying ? '无合约报价时间，按扫描参考 Ask 记 1 张纸上仓' : '按扫描参考 Bid 平仓'
    };
  }
  if (!evaluateFreshness({ quoteAt: quote?.quoteAt, last: ask }, now).fresh) return deny('quote-stale', '合约 Bid/Ask 时间缺失或超过 180 秒，不成交');
  const optionSession = sessionDenial(order, now);
  if (optionSession) return deny('outside-session', optionSession);
  const buying = ['buy', 'add'].includes(String(order.side).toLowerCase());
  const limit = num(order.limitPrice ?? order.price);
  if (!(limit > 0) || !(num(order.qty) > 0)) return deny('invalid-order', '限价与数量必须为正数');
  if (order.legs?.length > 1) return deny('single-leg-only', '纸上期权先只做单腿借记，价差和跨式不在这里撮合');
  const reference = buying ? ask : bid;
  const price = reference * (1 + (buying ? 1 : -1) * 0.0005);
  if ((buying && price > limit) || (!buying && price < limit)) return deny('limit-not-marketable', '限价未覆盖合约报价及 5bp 模拟滑点；IOC 未成交');
  return { ok: true, price, referencePrice: reference, slippageBps: 5, fee: 0, quoteAt: quote.quoteAt, model: 'paper-option-ioc-v1', feeNote: '佣金另计在推荐费用里；这里不把正股价当成期权成交价' };
}

/** IOC approximation, not an exchange fill: no fresh quote / no crossing => no fill. */
export function paperExecution(order, quote, now = Date.now()) {
  const deny = (code, message) => ({ ok: false, code, message });
  if (instrumentOf(order.instrument) === 'option') return paperOptionExecution(order, quote, now);
  if (instrumentOf(order.instrument) !== 'equity') return deny('contract-quote-required', '纸上只成交股票，或带报价时间的单腿期权');
  if (!quote?.ok || !(num(quote.last) > 0)) return deny('quote-unavailable', '无独立行情，不使用限价或旧持仓价代替');
  if (order.paperReference === true) {
    const buying = ['buy', 'add'].includes(String(order.side).toLowerCase());
    const limit = num(order.limitPrice ?? order.price);
    if (!(limit > 0) || !(num(order.qty) > 0)) return deny('invalid-order', '限价与数量必须为正数');
    const reference = quote.last;
    const price = reference * (1 + (buying ? 1 : -1) * 0.0005);
    if ((buying && price > limit) || (!buying && price < limit)) return deny('limit-not-marketable', '限价未覆盖最近成交价');
    return { ok: true, price, referencePrice: reference, slippageBps: 5, fee: 0, quoteAt: quote.quoteAt ?? null, model: 'paper-equity-reference-v1', feeNote: '不在常规交易时段或报价已过 180 秒，按最近一次成交价记纸上仓' };
  }
  if (!evaluateFreshness({ quoteAt: quote.quoteAt, last: quote.last }, now).fresh) return deny('quote-stale', '行情源时间戳缺失或超过 180 秒，不成交');
  const equitySession = sessionDenial(order, now);
  if (equitySession) return deny('outside-session', equitySession);
  const buying = ['buy', 'add'].includes(String(order.side).toLowerCase());
  const limit = num(order.limitPrice ?? order.price);
  if (!(limit > 0) || !(num(order.qty) > 0)) return deny('invalid-order', '限价与数量必须为正数');
  const reference = num(buying ? quote.ask : quote.bid) || quote.last;
  const price = reference * (1 + (buying ? 1 : -1) * 0.0005);
  if ((buying && price > limit) || (!buying && price < limit)) return deny('limit-not-marketable', '限价未覆盖行情及 5bp 模拟滑点；IOC 未成交，不保留挂单');
  return { ok: true, price, referencePrice: reference, slippageBps: 5, fee: 0, quoteAt: quote.quoteAt, model: 'paper-ioc-v2', feeNote: '佣金设为零；借券、税费与冲击成本未建模' };
}
