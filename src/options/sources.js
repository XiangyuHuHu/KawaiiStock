import { todayStamp } from '../paths.js';

// Keep the price and its source timestamp together; never borrow a time from another price.
export function chooseUnderlyingQuote(chain = {}, quote = {}, chart = {}, now = Date.now()) {
  const candidates = [
    { last: chain.last, quoteAt: chain.underlyingQuoteAt, source: chain.underlyingSource || chain.source },
    { last: quote.last, quoteAt: quote.quoteAt, source: quote.source || 'yahoo' },
    { last: chart.last, quoteAt: chart.quoteAt, source: chart.source }
  ];
  return candidates.filter(c => c.last > 0 && Number.isFinite(c.quoteAt) && c.quoteAt > 0 && c.quoteAt <= now + 5000).sort((a, b) => b.quoteAt - a.quoteAt)[0]
    || { ...(candidates.find(c => c.last > 0) || { last: null }), quoteAt: null };
}

export function parseEarningsDate(data, now = Date.now()) {
  const text = [data?.announcement, data?.reportText, data?.eQRResposeModel?.text, data?.eQRResposeModel?.boldText].filter(Boolean).join(' ');
  // Only a vendor's explicitly supplied upcoming date, never a historical EPS table.
  const raw = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!raw || /hasn't provided|has not provided|not available/i.test(text)) return { date: null, status: 'unknown' };
  const day = `${raw[3]}-${raw[1].padStart(2, '0')}-${raw[2].padStart(2, '0')}`;
  const date = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day || day < todayStamp(new Date(now))) return { date: null, status: 'unknown' };
  return { date: day, status: 'estimated', timeKnown: false };
}

export function sourceDiagnostics(ctx, now = Date.now()) {
  const chain = ctx.chain || {}, all = [...(chain.calls || []), ...(chain.puts || [])];
  const quoteCount = all.filter(l => l.quoteAt > 0).length;
  const gap = (key, label, status, reason, nextStep) => ({ key, label, status, reason, nextStep });
  return [
    gap('underlying', '标的价格及来源时间', ctx.quoteAt > 0 ? (now - ctx.quoteAt > 180000 ? 'stale' : 'available') : 'missing', ctx.quoteAt > 0 ? `${ctx.quoteSource || '来源未知'}；价格和时间同源` : '没有与此价格匹配的报价时间', '常规交易时段刷新；缺时间时更换可验证来源'),
    gap('optionQuotes', '期权双边报价时间', !all.length || !quoteCount ? 'missing' : quoteCount < all.length ? 'partial' : 'available', `${chain.source || '未知来源'}：${quoteCount}/${all.length} 份合约有双边时间；仍须逐腿检查时效`, '免费源不提供该字段；需配置带报价时间的行情权限，抓取时间不能补齐'),
    gap('earnings', '未来财报日期', chain.earnings?.status === 'not-applicable' ? 'not-applicable' : chain.earnings?.date ? 'available' : 'missing', chain.earnings?.status === 'not-applicable' ? '来源明确标记 ETF，公司财报日期不适用' : chain.earnings?.date ? `${chain.earnings.date} · ${chain.earnings.source} · ${chain.earnings.status === 'estimated' ? '估计日期，未提供时刻' : '来源日期'}` : '来源未公布可用的未来日期，不能当成近期无财报', '临近财报保持阻断；无日期时等待来源更新或核实公司公告'),
    gap('units', '交割单位', all.length && all.every(l => l.standard && l.multiplier === 100) ? 'available' : 'partial', '每张 100 股依据提供方字段或标准上市代码推断；推断不等于核实交割明细', '非标准、调整合约及标识不一致时保留为参考')
  ];
}
