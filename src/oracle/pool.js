import { loadUniverse } from '../universe.js';

export const ORACLE_CORE = [
  ['SPY', '标普 500 ETF'],
  ['QQQ', '纳指 100 ETF'],
  ['IWM', '罗素 2000 ETF'],
  ['DIA', '道指 ETF'],
  ['GLD', '黄金 ETF'],
  ['SLV', '白银 ETF'],
  ['TLT', '长期美债 ETF']
].map(([symbol, name]) => ({ symbol, name, market: 'us', from: '跨资产观察' }));

const EQUITY = /^[A-Z][A-Z.]{0,9}$/;

/** One deduped US pool for 梅花 and 奇门. Counts must match. */
export async function sharedOracleUniverse() {
  const universe = await loadUniverse();
  const rows = [];
  const seen = new Set();
  const excluded = [];
  for (const core of ORACLE_CORE) {
    seen.add(core.symbol);
    rows.push({ ...core });
  }
  for (const row of universe.symbols || []) {
    const symbol = String(row.symbol || '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    if (!EQUITY.test(symbol)) {
      excluded.push(symbol);
      continue;
    }
    seen.add(symbol);
    rows.push({
      symbol,
      name: symbol,
      market: 'us',
      from: universe.fallback ? 'watchlist-fallback' : 'watchlist'
    });
  }
  rows.poolSource = universe.fallback ? 'watchlist-fallback' : 'research-universe';
  rows.poolNote = universe.note || null;
  rows.symbolCount = rows.length;
  rows.excluded = excluded;
  rows.timeZone = 'America/New_York';
  rows.timeLabel = '美东观察日';
  rows.qimenTimeZone = 'Asia/Shanghai';
  rows.qimenTimeLabel = '北京时间整点';
  return rows;
}
