import { paperMarketOf } from './sessions.js';

function countReasons(rows) {
  const out = {};
  for (const row of rows || []) {
    const name = row?.reason || 'unspecified';
    out[name] = (out[name] || 0) + 1;
  }
  return out;
}

function limitUpPoolStatus(session) {
  const dynamic = session.sources?.universe?.dynamic;
  if (!dynamic) return null;
  return {
    ok: !dynamic.error,
    error: dynamic.error || null,
    requestedDate: dynamic.requestedDate || null,
    days: dynamic.days || [],
    added: dynamic.added ?? 0
  };
}

/** 一轮纸上跑完后的柜台摘要：扫了多少、为什么被扔掉、下了几笔。涨停池失败写在 limitUpPool，不再只留在被吞掉的异常里。 */
export function buildDiagnostics(session = {}) {
  const orders = (session.fills || []).filter((row) => row && row.ok && !row.replay);
  const scan = session.scan || {};
  return {
    desk: session.desk || null,
    market: paperMarketOf(session.desk),
    scanned: scan.scanned ?? session.sources?.scanned ?? null,
    eligible: scan.eligible ?? session.sources?.eligible ?? null,
    ordersPlaced: orders.length,
    orders: orders.map((row) => ({
      symbol: row.symbol || null,
      side: row.side || null,
      qty: row.qty ?? null,
      price: row.price ?? null
    })),
    filterRejections: scan.rejections || {},
    skipRejections: countReasons(session.skipped),
    microstructure: scan.microstructure || null,
    limitUpPool: limitUpPoolStatus(session)
  };
}

export function topReasons(map, limit = 4) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join('；');
}
