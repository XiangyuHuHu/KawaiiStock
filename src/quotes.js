const UA = 'Mozilla/5.0 (compatible; KawaiiResearchDesk/0.1)';
const cache = new Map();
const CACHE_MS = 60_000;

function parseMoney(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[$,%]/g, '').replace(/^\((.+)\)$/, '-$1'));
  return Number.isFinite(n) ? n : null;
}

function downsample(points, count = 24) {
  if (points.length <= count) return points;
  const step = (points.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => points[Math.round(i * step)]);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function zonedWallTimeToUtc(year, monthIndex, day, hour, minute, second, timeZone) {
  const utcGuess = Date.UTC(year, monthIndex, day, hour, minute, second);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcGuess)).map((row) => [row.type, row.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return utcGuess - (asUtc - utcGuess);
}

/** Nasdaq info 的 lastTradeTimestamp，例如 Sep 28, 2026 10:22 AM ET。 */
export function parseNasdaqTradeTime(text) {
  const match = String(text || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)\s+ET$/i);
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  let hour = Number(match[4]) % 12;
  if (match[7].toUpperCase() === 'PM') hour += 12;
  return zonedWallTimeToUtc(Number(match[3]), month, Number(match[2]), hour, Number(match[5]), Number(match[6] || 0), 'America/New_York');
}

async function fetchNasdaqInfo(symbol, assetClass = 'stocks') {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`quote ${symbol} ${response.status}`);
  const data = (await response.json())?.data;
  const primary = data?.primaryData;
  const last = parseMoney(primary?.lastSalePrice);
  const quoteAt = parseNasdaqTradeTime(primary?.lastTradeTimestamp);
  if (!(last > 0) || !(quoteAt > 0)) throw new Error(`quote ${symbol} empty`);
  const change = parseMoney(primary?.netChange);
  const changePct = parseMoney(primary?.percentageChange);
  return {
    symbol,
    source: 'nasdaq-info',
    quoteAt,
    fetchedAt: Date.now(),
    last,
    bid: parseMoney(primary?.bidPrice),
    ask: parseMoney(primary?.askPrice),
    prev: change != null ? last - change : null,
    change,
    changePct,
    currency: 'USD',
    exchange: data?.exchange || '',
    spark: [],
    ok: true
  };
}

async function fetchNasdaq(symbol) {
  const errors = [];
  for (const assetClass of ['stocks', 'etf']) {
    try { return await fetchNasdaqInfo(symbol, assetClass); }
    catch (error) { errors.push(error.message); }
    try { return await fetchNasdaqChart(symbol, assetClass); }
    catch (error) { errors.push(error.message); }
  }
  throw new Error(errors.join('; ') || `quote ${symbol} empty`);
}

async function fetchNasdaqChart(symbol, assetClass = 'stocks') {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${assetClass}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`quote ${symbol} ${response.status}`);
  const json = await response.json();
  const data = json?.data;
  if (!data?.lastSalePrice) throw new Error(`quote ${symbol} empty`);
  const point = (data.chart || []).filter((row) => Number(row.x) > 0 && Number(row.y) > 0).at(-1);
  const last = point ? Number(point.y) : parseMoney(data.lastSalePrice);
  const previous = parseMoney(data.previousClose);
  const change = previous > 0 ? last - previous : null;
  const changePct = previous > 0 ? change / previous * 100 : null;
  const spark = downsample((data.chart ?? []).map((row) => Number(row.y)).filter(Number.isFinite));
  return {
    symbol,
    source: 'nasdaq-chart',
    quoteAt: point ? Number(point.x) : null,
    fetchedAt: Date.now(),
    last,
    prev: parseMoney(data.previousClose),
    change,
    changePct,
    currency: 'USD',
    exchange: data.exchange || '',
    spark,
    ok: true
  };
}

export async function loadQuotes(symbols, { concurrency = 4 } = {}) {
  const unique = [...new Set(symbols.filter(Boolean))];
  const out = {};
  const now = Date.now();
  const pending = [];

  for (const symbol of unique) {
    const hit = cache.get(symbol);
    if (hit && now - hit.at < CACHE_MS) {
      out[symbol] = hit.value;
    } else {
      pending.push(symbol);
    }
  }

  let index = 0;
  async function worker() {
    while (index < pending.length) {
      const current = index;
      index += 1;
      const symbol = pending[current];
      try {
        const value = await fetchNasdaq(symbol);
        cache.set(symbol, { at: Date.now(), value });
        out[symbol] = value;
      } catch (error) {
        out[symbol] = { symbol, ok: false, error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  return out;
}
