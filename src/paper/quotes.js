import { loadQuotes } from '../quotes.js';
import { fetchChinaQuotes } from '../screener/cn-market-data.mjs';

export function isCnEquity(symbol) {
  return /^\d{6}$/.test(String(symbol || ''));
}

/** 美股走 Nasdaq。六位 A 股代码走东财，避免把 300383 送去 Nasdaq 空等超时。 */
export async function loadEquityQuotes(symbols) {
  const unique = [...new Set((symbols || []).filter(Boolean))];
  if (!unique.length) return {};
  const cn = unique.filter(isCnEquity);
  const us = unique.filter((symbol) => !isCnEquity(symbol));
  const quotes = us.length ? await loadQuotes(us) : {};
  if (!cn.length) return quotes;
  let map = new Map();
  try {
    map = await fetchChinaQuotes(cn.map((symbol) => ({ symbol })));
  } catch {
    map = new Map();
  }
  const now = Date.now();
  for (const symbol of cn) {
    const row = map.get(symbol);
    quotes[symbol] = row?.price > 0
      ? {
        ok: true,
        symbol,
        last: row.price,
        bid: null,
        ask: null,
        high: row.high ?? null,
        quoteAt: now,
        changePct: row.dailyChange ?? null,
        source: 'eastmoney',
        currency: 'CNY',
        company: row.company || ''
      }
      : { ok: false, symbol, error: 'cn-quote-unavailable' };
  }
  return quotes;
}
