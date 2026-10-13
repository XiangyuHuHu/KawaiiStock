import { finiteNumber as num } from './numbers.js';
const UA = 'Mozilla/5.0 (compatible; KawaiiResearchDesk/0.1)';
const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;

function stamp(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function cleanBars(rows) {
  return (rows || [])
    .map((row) => ({
      date: row.date,
      ...(num(row.ts) > 0 ? { ts: num(row.ts) } : {}),
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.close),
      volume: num(row.volume) ?? 0
    }))
    .filter((row) => row.date && row.close > 0 && row.high > 0 && row.low > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`yahoo ${symbol} ${response.status}`);
  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const bars = ts.map((t, i) => ({
    date: stamp(t * 1000),
    open: q.open?.[i],
    high: q.high?.[i],
    low: q.low?.[i],
    close: q.close?.[i],
    volume: q.volume?.[i]
  }));
  const out = cleanBars(bars);
  if (out.length < 40) throw new Error(`yahoo ${symbol} bars ${out.length}`);
  return { bars: out, source: 'yahoo' };
}

function parseNasdaqDate(value) {
  const text = String(value || '');
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const ETF_HINT = /^(QQQ|SPY|IWM|DIA|TQQQ|SQQQ|QLD|SSO|QID|PSQ|VOO|VTI|ARKK|SOXL|SOXS|TNA|TZA|SPXL|SPXS|TECL|TECS|FAS|FAZ|LABU|LABD|NVDL|USD|ROM|UYG|DIG|ERX|BOIL|AGQ|KWEB|XLF|XLK|XLE|SMH|IBIT|GLD|SLV|TLT|HYG|LQD)$/;

async function fetchNasdaqHistory(symbol, assetclass = 'stocks') {
  const today = new Date();
  const from = new Date(today);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${fmt(from)}&todate=${fmt(today)}&limit=400`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`nasdaq ${symbol} ${response.status}`);
  const json = await response.json();
  const rows = json?.data?.tradesTable?.rows || [];
  const bars = rows.map((row) => ({
    date: parseNasdaqDate(row.date),
    open: String(row.open || '').replace(/[$,]/g, ''),
    high: String(row.high || '').replace(/[$,]/g, ''),
    low: String(row.low || '').replace(/[$,]/g, ''),
    close: String(row.close || '').replace(/[$,]/g, ''),
    volume: String(row.volume || '').replace(/,/g, '')
  }));
  const out = cleanBars(bars);
  if (out.length < 40) throw new Error(`nasdaq ${symbol} ${assetclass} bars ${out.length}`);
  return { bars: out, source: `nasdaq-${assetclass}` };
}

export async function loadHistoricals(symbol, { refresh = false } = {}) {
  const key = String(symbol || '').toUpperCase();
  if (!key) throw new Error('missing-symbol');
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let lastError = '';
  const nasdaqOrder = ETF_HINT.test(key)
    ? [() => fetchNasdaqHistory(key, 'etf'), () => fetchNasdaqHistory(key, 'stocks')]
    : [() => fetchNasdaqHistory(key, 'stocks'), () => fetchNasdaqHistory(key, 'etf')];
  for (const fn of [() => fetchYahoo(key), ...nasdaqOrder]) {
    try {
      const value = { symbol: key, ok: true, ...await fn() };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      lastError = error.message;
    }
  }
  const fail = { symbol: key, ok: false, bars: [], error: lastError || 'no-historicals' };
  cache.set(key, { at: Date.now(), value: fail });
  return fail;
}

export async function loadManyHistoricals(symbols, { concurrency = 4 } = {}) {
  const unique = [...new Set(symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))];
  const out = {};
  let index = 0;
  async function worker() {
    while (index < unique.length) {
      const current = index;
      index += 1;
      const symbol = unique[current];
      out[symbol] = await loadHistoricals(symbol);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()));
  return out;
}
