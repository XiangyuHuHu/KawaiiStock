import { sessionOpenMs } from './market-time.js';

/** Historical next-open model. Never infer an intraday limit touch from a close. */
export function historicalExecution(rec, bar, generatedAt) {
  const at = typeof generatedAt === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(generatedAt) ? Date.parse(generatedAt) : NaN;
  if (!bar || !(bar.open > 0)) return { ok: false, reason: '缺少当日历史开盘价，不以当前报价代替' };
  const executionAt = sessionOpenMs(bar.date);
  if (!Number.isFinite(at) || at >= executionAt) return { ok: false, reason: '推荐缺少可靠生成时间或生成晚于成交时刻，不能回填成交' };
  const expiry = rec.validUntil ?? rec.valid_until;
  if (expiry) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? sessionOpenMs(expiry) + 6.5 * 3600000 : Date.parse(expiry);
    if (!Number.isFinite(end) || executionAt > end) return { ok: false, reason: '推荐已过期或有效期无法解析' };
  }
  const buy = ['BUY', 'ADD'].includes(String(rec.action).toUpperCase());
  const price = bar.open * (1 + (buy ? 1 : -1) * 0.0005);
  if (rec.limitPrice != null && (!(rec.limitPrice > 0) || (buy ? price > rec.limitPrice : price < rec.limitPrice))) return { ok: false, reason: '次日开盘及 5bp 滑点未满足限价；不假设盘中成交' };
  return { ok: true, price, executionAt: new Date(executionAt).toISOString(), model: 'next-open-v2', slippageBps: 5 };
}
