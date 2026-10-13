import https from 'node:https';
import { loadTradierChain, providerStatus } from './providers.js';
import { parseEarningsDate } from './sources.js';
import { cleanBars } from '../historicals.js';
import { daysBetween } from './math.js';
import { todayStamp } from '../paths.js';
import { finiteNumber } from '../numbers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const cache = new Map();
const NASDAQ_HEADERS = {
  Accept: 'application/json',
  'User-Agent': UA,
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/'
};

function num(value) {
  if (value == null || value === '--' || value === 'N/A') return null;
  return finiteNumber(String(value).replace(/[$,%]/g, '').replace(/^\((.+)\)$/, '-$1'));
}

function normRoot(value) {
  return String(value || '').replaceAll('.', '').toUpperCase();
}

/** Standard 100-share listed equity/ETF options. Explicit non-REGULAR size still wins. */
export function listedEquityOptionUnit({ contractSize, contractSymbol, underlying } = {}) {
  const size = String(contractSize || '').trim().toUpperCase();
  if (size === 'REGULAR') return { standard: true, multiplier: 100, unitSource: 'contractSize' };
  if (size) return { standard: false, multiplier: null, unitSource: 'contractSize' };
  const raw = String(contractSymbol || '').trim();
  const yahoo = raw.toUpperCase().match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  const nasdaq = raw.toLowerCase().match(/^([a-z][a-z0-9.]{0,5})--(\d{6})([cp])(\d{8})$/);
  const parsed = yahoo || nasdaq;
  if (!parsed) return { standard: false, multiplier: null, unitSource: 'unknown' };
  const root = normRoot(parsed[1]);
  const under = normRoot(underlying);
  if (under && root !== under) return { standard: false, multiplier: null, unitSource: 'root-mismatch' };
  if (/\d$/.test(root) && root !== under) return { standard: false, multiplier: null, unitSource: 'adjusted-root' };
  return { standard: true, multiplier: 100, unitSource: 'listed-osi' };
}

export function nasdaqLegSymbol(row, type, expiration) {
  const last = String(row?.drillDownURL || '').split('/').filter(Boolean).at(-1) || '';
  const occType = type === 'put' ? 'p' : 'c';
  const parsed = last.match(/^([A-Za-z0-9.]+)--(\d{6})[cp](\d+)$/i);
  if (parsed) return `${parsed[1].toLowerCase()}--${parsed[2]}${occType}${parsed[3]}`;
  const yymmdd = String(expiration || '').replace(/-/g, '').slice(2);
  const strike = num(row?.strike);
  if (yymmdd.length === 6 && strike != null) {
    const root = (last.split('--')[0] || 'unk').toLowerCase();
    return `${root}--${yymmdd}${occType}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
  }
  return last;
}

export function pickUnderlyingQuoteAt(chain = {}, intra = {}) {
  for (const ts of [chain.underlyingQuoteAt, intra.quoteAt]) {
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  return null;
}

function cacheGet(key, ms) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  return null;
}

function cacheSet(key, value) {
  const packed = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, fetchedAt: value.fetchedAt || Date.now() }
    : value;
  cache.set(key, { at: Date.now(), value: packed });
  return packed;
}

let yahooAuth = null;

export function clearMarketCache() {
  cache.clear();
  yahooAuth = null;
}

function cookieHeader(response) {
  const rows = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/);
  return rows.map((row) => String(row).split(';')[0].trim()).filter(Boolean).join('; ');
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, maxHeaderSize: 262144 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const cookies = [].concat(res.headers['set-cookie'] || []);
        resolve({
          status: res.statusCode || 0,
          cookie: cookies.map((row) => String(row).split(';')[0].trim()).filter(Boolean).join('; ')
        });
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('yahoo timeout')));
    req.on('error', reject);
  });
}

/** Yahoo 首页的 Set-Cookie 会撑爆 fetch 的默认头大小，改走可放大的 https。 */
async function yahooHome() {
  try {
    const home = await fetch('https://finance.yahoo.com/', {
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    return { status: home.status, cookie: cookieHeader(home) };
  } catch (error) {
    const detail = `${error?.cause?.code || ''} ${error?.message || error}`;
    if (!/HEADERS_OVERFLOW|fetch failed/i.test(detail)) throw error;
    return httpsGet('https://finance.yahoo.com/', { Accept: 'text/html', 'User-Agent': UA });
  }
}

/** Yahoo v7 期权链不带 cookie 和 crumb 会 401。图表接口不走这里。 */
async function yahooSession({ refresh = false } = {}) {
  if (!refresh && yahooAuth && Date.now() - yahooAuth.at < 30 * 60 * 1000) return yahooAuth;
  const home = await yahooHome();
  if (home.status >= 400) throw new Error(`yahoo home ${home.status}`);
  const cookie = home.cookie;
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { Accept: 'text/plain', 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(12000)
  });
  if (!crumbRes.ok) throw new Error(`yahoo crumb ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || /[<>\s]/.test(crumb)) throw new Error('yahoo crumb empty');
  yahooAuth = { cookie, crumb, at: Date.now() };
  return yahooAuth;
}

async function fetchJson(url, timeoutMs = 15000, headers = { Accept: 'application/json', 'User-Agent': UA }) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  return response.json();
}

function chartBars(json, { stampSeconds = false } = {}) {
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const rows = ts.map((t, i) => {
    const ms = t * 1000;
    const iso = new Date(ms).toISOString();
    return {
      date: stampSeconds ? iso : iso.slice(0, 10),
      ts: ms,
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i]
    };
  });
  return cleanBars(rows);
}

function nasdaqIntradayBars(json) {
  const points = json?.data?.chart || [];
  const volPts = json?.data?.volumeChart || [];
  const volByX = new Map(volPts.map((row) => [row.x, num(row.y)]));
  const buckets = new Map();
  for (const row of points) {
    const ms = Number(row.x);
    const px = num(row.y);
    if (!Number.isFinite(ms) || px == null) continue;
    const bucket = Math.floor(ms / 300000) * 300000;
    let cur = buckets.get(bucket);
    if (!cur) {
      cur = {
        ts: bucket,
        date: new Date(bucket).toISOString(),
        open: px,
        high: px,
        low: px,
        close: px,
        volume: 0
      };
      buckets.set(bucket, cur);
    }
    cur.high = Math.max(cur.high, px);
    cur.low = Math.min(cur.low, px);
    cur.close = px;
    cur.volume += volByX.get(ms) || 0;
  }
  return cleanBars([...buckets.values()].sort((a, b) => a.ts - b.ts));
}

async function loadYahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const json = await fetchJson(url);
  const bars = chartBars(json, { stampSeconds: interval !== '1d' && interval !== '1wk' });
  const meta = json?.chart?.result?.[0]?.meta || {};
  if (bars.length < 8) throw new Error(`bars ${bars.length}`);
  return {
    symbol,
    ok: true,
    range,
    interval,
    bars,
    last: num(meta.regularMarketPrice) ?? bars.at(-1)?.close,
    quoteAt: num(meta.regularMarketPrice) > 0 && num(meta.regularMarketTime) > 0 ? num(meta.regularMarketTime) * 1000 : null,
    source: 'yahoo'
  };
}

async function loadNasdaqIntraday(symbol) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=stocks`;
  const json = await fetchJson(url, 12000, NASDAQ_HEADERS);
  const bars = nasdaqIntradayBars(json);
  if (bars.length < 4) throw new Error(`nasdaq bars ${bars.length}`);
  return {
    symbol,
    ok: true,
    range: '1d',
    interval: '5m',
    bars,
    last: bars.at(-1)?.close ?? num(String(json?.data?.lastSalePrice || '').replace(/[$,]/g, '')),
    quoteAt: bars.at(-1)?.ts ?? null,
    source: 'nasdaq'
  };
}

export async function loadChart(symbol, { range = '1y', interval = '1d', refresh = false } = {}) {
  const key = `${symbol}:${range}:${interval}`;
  const hit = refresh ? null : cacheGet(key, interval === '1d' ? 15 * 60 * 1000 : 5 * 60 * 1000);
  if (hit) return hit;
  try {
    return cacheSet(key, await loadYahooChart(symbol, range, interval));
  } catch (yahooError) {
    if (interval === '5m' || interval === '1m' || interval === '15m') {
      try {
        return cacheSet(key, await loadNasdaqIntraday(symbol));
      } catch (nasdaqError) {
        return cacheSet(key, {
          symbol,
          ok: false,
          range,
          interval,
          bars: [],
          error: `${yahooError.message}; nasdaq ${nasdaqError.message}`
        });
      }
    }
    return cacheSet(key, { symbol, ok: false, range, interval, bars: [], error: yahooError.message });
  }
}

export function mapYahooContract(row, type, expiration, underlying = '') {
  const bid = num(row.bid);
  const ask = num(row.ask);
  const last = num(row.lastPrice);
  const mid = bid != null && ask != null && ask >= bid
    ? (bid + ask) / 2
    : (last ?? bid ?? ask);
  const unit = listedEquityOptionUnit({
    contractSize: row.contractSize,
    contractSymbol: row.contractSymbol,
    underlying
  });
  return {
    contractSymbol: row.contractSymbol || '',
    // Last trade time is not the timestamp of today's bid/ask.
    quoteAt: null,
    lastTradeAt: num(row.lastTradeDate) > 0 ? num(row.lastTradeDate) * 1000 : null,
    multiplier: unit.multiplier,
    standard: unit.standard,
    unitSource: unit.unitSource,
    type,
    expiration: num(row.expiration) > 0 ? new Date(num(row.expiration) * 1000).toISOString().slice(0, 10) : expiration,
    strike: num(row.strike),
    bid,
    ask,
    last,
    mid,
    volume: num(row.volume),
    openInterest: num(row.openInterest),
    iv: num(row.impliedVolatility),
    inTheMoney: Boolean(row.inTheMoney)
  };
}

function expirationFromNasdaq(row, fallback) {
  const url = String(row.drillDownURL || '');
  const m = url.match(/--(\d{6})[cp]/i);
  if (m) {
    const raw = m[1];
    return `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
  }
  const group = String(row.expirygroup || fallback || '');
  const parsed = Date.parse(group);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return fallback || null;
}

export function mapNasdaqContract(row, type, expiration, underlying = '') {
  const prefix = type === 'call' ? 'c_' : 'p_';
  const bid = num(row[`${prefix}Bid`]);
  const ask = num(row[`${prefix}Ask`]);
  const last = num(row[`${prefix}Last`]);
  const mid = bid != null && ask != null && ask >= bid
    ? (bid + ask) / 2
    : (last ?? bid ?? ask);
  if (row.strike == null && mid == null) return null;
  const contractSymbol = nasdaqLegSymbol(row, type, expiration);
  const unit = listedEquityOptionUnit({ contractSymbol, underlying });
  return {
    contractSymbol,
    quoteAt: null,
    multiplier: unit.multiplier,
    standard: unit.standard,
    unitSource: unit.unitSource,
    type,
    expiration: num(row.expiration) > 0 ? new Date(num(row.expiration) * 1000).toISOString().slice(0, 10) : expiration,
    strike: num(row.strike),
    bid,
    ask,
    last,
    mid,
    volume: num(row[`${prefix}Volume`]),
    openInterest: num(row[`${prefix}Openinterest`]),
    iv: null,
    inTheMoney: Boolean(row[`${prefix}colour`])
  };
}

async function loadYahooChain(symbol, expirationUnix) {
  const session = await yahooSession();
  const params = new URLSearchParams();
  if (expirationUnix) params.set('date', String(expirationUnix));
  params.set('crumb', session.crumb);
  const headers = {
    Accept: 'application/json',
    'User-Agent': UA,
    ...(session.cookie ? { Cookie: session.cookie } : {})
  };
  const urlFor = (auth) => {
    params.set('crumb', auth.crumb);
    return `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?${params}`;
  };
  let json;
  try {
    json = await fetchJson(urlFor(session), 12000, headers);
  } catch (error) {
    if (!/http 40[13]/.test(error.message)) throw error;
    const fresh = await yahooSession({ refresh: true });
    json = await fetchJson(urlFor(fresh), 12000, {
      ...headers,
      ...(fresh.cookie ? { Cookie: fresh.cookie } : {})
    });
  }
  const result = json?.optionChain?.result?.[0];
  if (!result) throw new Error('empty-chain');
  const quote = result.quote || {};
  const expirations = (result.expirationDates || []).map((n) => Number(n)).filter(Number.isFinite);
  const pack = result.options?.[0] || {};
  const expiration = pack.expirationDate
    ? new Date(pack.expirationDate * 1000).toISOString().slice(0, 10)
    : null;
  return {
    symbol,
    ok: true,
    source: 'yahoo',
    assetType: quote.quoteType === 'ETF' ? 'etf' : quote.quoteType === 'EQUITY' ? 'equity' : null,
    last: num(quote.regularMarketPrice),
    underlyingQuoteAt: num(quote.regularMarketTime) > 0 ? num(quote.regularMarketTime) * 1000 : null,
    quoteAt: null,
    prev: num(quote.regularMarketPreviousClose),
    earningsTs: num(quote.earningsTimestamp) || num(quote.earningsTimestampStart),
    expirationDates: expirations,
    expiration,
    calls: (pack.calls || []).map((row) => mapYahooContract(row, 'call', expiration, symbol)),
    puts: (pack.puts || []).map((row) => mapYahooContract(row, 'put', expiration, symbol))
  };
}

export async function loadYahooQuote(symbol) {
  const key = `quote:${symbol}`;
  const hit = cacheGet(key, 30000);
  if (hit) return hit;
  try {
    const json = await fetchJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`, 8000);
    const q = json?.quoteResponse?.result?.[0] || {};
    return cacheSet(key, {
      ok: true, source: 'yahoo',
      assetType: q.quoteType === 'ETF' ? 'etf' : q.quoteType === 'EQUITY' ? 'equity' : null,
      last: num(q.regularMarketPrice),
      quoteAt: num(q.regularMarketTime) > 0 ? num(q.regularMarketTime) * 1000 : null,
      earningsTs: num(q.earningsTimestamp) || num(q.earningsTimestampStart) || num(q.earningsTimestampEnd) || null
    });
  } catch (error) {
    return cacheSet(key, { ok: false, error: error.message, last: null, quoteAt: null, earningsTs: null });
  }
}

async function loadNasdaqChain(symbol) {
  let lastError = 'empty-nasdaq-chain';
  for (const assetclass of ['stocks', 'etf']) {
    try {
      const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain?assetclass=${assetclass}&money=all`;
      const json = await fetchJson(url, 15000, NASDAQ_HEADERS);
      const table = json?.data?.table?.rows || [];
      if (!table.length) {
        lastError = `empty-nasdaq-chain:${assetclass}`;
        continue;
      }
      const lastTrade = num(String(json?.data?.lastTrade || '').match(/\$([0-9.]+)/)?.[1]);
      const calls = [];
      const puts = [];
      let group = '';
      for (const row of table) {
        if (row.expirygroup) group = row.expirygroup;
        if (row.strike == null) continue;
        const expiration = expirationFromNasdaq({ ...row, expirygroup: row.expirygroup || group }, null);
        const call = mapNasdaqContract(row, 'call', expiration, symbol);
        const put = mapNasdaqContract(row, 'put', expiration, symbol);
        if (call?.strike != null && (call.mid != null || call.ask != null || call.last != null)) calls.push(call);
        if (put?.strike != null && (put.mid != null || put.ask != null || put.last != null)) puts.push(put);
      }
      if (!calls.length && !puts.length) {
        lastError = `no-contracts:${assetclass}`;
        continue;
      }
      const dates = [...new Set([...calls, ...puts].map((row) => row.expiration).filter(Boolean))].sort();
      return {
        symbol,
        ok: true,
        source: 'nasdaq',
        last: lastTrade,
        prev: null,
        earningsTs: null,
        expirationDates: dates.map((d) => Math.floor(new Date(`${d}T20:00:00Z`).getTime() / 1000)),
        expiration: dates[0] || null,
        calls,
        puts
      };
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(lastError);
}

export async function loadOptionChain(symbol, expirationUnix, { refresh = false, maxAgeMs } = {}) {
  const provider = providerStatus();
  const key = `chain:${provider.provider}:${provider.sandbox}:${symbol}:${expirationUnix || 'near'}`;
  const ttl = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : (provider.configured ? 30000 : 5 * 60 * 1000);
  const hit = refresh ? null : cacheGet(key, ttl);
  if (hit) return hit;
  let providerError = null;
  if (provider.configured) {
    try { return cacheSet(key, await loadTradierChain(symbol, expirationUnix)); } catch (error) { providerError = error.message; }
  }
  try {
    return cacheSet(key, { providerError, ...await loadYahooChain(symbol, expirationUnix) });
  } catch (yahooError) {
    try {
      return cacheSet(key, { providerError, ...await loadNasdaqChain(symbol) });
    } catch (nasdaqError) {
      return cacheSet(key, {
        symbol,
        ok: false,
        error: `${providerError || ''}; ${yahooError.message}; nasdaq ${nasdaqError.message}`,
        calls: [],
        puts: [],
        expirationDates: []
      });
    }
  }
}

const TARGET_DTE = 14;

function expirationDate(value) {
  if (typeof value === 'number') return new Date(value * 1000).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

/** 3–45 天里按接近 14 天排序。不拿列表里最早的一周，避免所有标的都落在同一个近周到期日。 */
export function rankExpirations(values, { minDte = 3, maxDte = 45, asOf, targetDte = TARGET_DTE } = {}) {
  const seen = new Set();
  const ranked = [];
  for (const value of values || []) {
    const date = expirationDate(value);
    if (!date || seen.has(date)) continue;
    seen.add(date);
    const dte = daysBetween(asOf, date);
    if (dte == null || dte < minDte || dte > maxDte) continue;
    ranked.push({
      date,
      dte,
      ts: typeof value === 'number' ? value : Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
    });
  }
  ranked.sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte) || a.dte - b.dte);
  return ranked;
}

export function pickExpiration(chain, { minDte, maxDte, asOf }) {
  const ranked = rankExpirations(
    [...(chain.calls || []), ...(chain.puts || [])].map((row) => row.expiration),
    { minDte, maxDte, asOf }
  );
  const wanted = ranked[0];
  if (!wanted) return { ...chain, ok: false, error: '无符合期限的合约', calls: [], puts: [], expiration: null, dte: null, expirationCandidates: [] };
  return {
    ...chain,
    expiration: wanted.date,
    dte: wanted.dte,
    expirationCandidates: ranked.slice(0, 4),
    calls: (chain.calls || []).filter((row) => row.expiration === wanted.date),
    puts: (chain.puts || []).filter((row) => row.expiration === wanted.date)
  };
}

/** Load the chain that actually contains `expiration`, not whichever near expiry the vendor returned first. */
export async function loadExpirationChain(symbol, expiration, { loader = loadOptionChain, maxAgeMs } = {}) {
  const ms = Date.parse(`${expiration}T00:00:00Z`);
  const unix = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  const opts = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? { maxAgeMs } : {};
  const has = (chain) => [...(chain?.calls || []), ...(chain?.puts || [])].some((leg) => leg.expiration === expiration);
  let chain = await loader(symbol, unix, opts);
  if (has(chain)) return chain;
  let dates = chain?.expirationDates || [];
  if (!dates.length) {
    const near = await loader(symbol, undefined, opts);
    if (has(near)) return near;
    dates = near?.expirationDates || [];
  }
  const match = dates.find((ts) => Number.isFinite(Number(ts))
    && new Date(Number(ts) * 1000).toISOString().slice(0, 10) === expiration);
  if (match == null || Number(match) === unix) return chain;
  return loader(symbol, Number(match), opts);
}

export async function loadBestChain(symbol, { minDte = 3, maxDte = 45, now = new Date(), loader = loadOptionChain } = {}) {
  const asOf = todayStamp(now);
  const first = await loader(symbol);
  if (!first.ok) return first;
  if (first.source === 'nasdaq') return pickExpiration(first, { minDte, maxDte, asOf });
  const ranked = rankExpirations(first.expirationDates, { minDte, maxDte, asOf });
  if (!ranked.length) return { ...first, ok: false, error: '无符合期限的合约', calls: [], puts: [], expirationCandidates: [] };
  let last = null;
  for (const candidate of ranked.slice(0, 4)) {
    const picked = first.expiration === candidate.date ? first : await loader(symbol, candidate.ts);
    if (!picked.ok) {
      last = picked;
      continue;
    }
    if (['yahoo', 'tradier'].includes(picked.source) && picked.expiration !== candidate.date) {
      last = { ...picked, ok: false, error: '返回到期日与请求不一致', calls: [], puts: [] };
      continue;
    }
    const chosen = pickExpiration(picked, { minDte, maxDte, asOf });
    if (chosen.ok && ((chosen.calls || []).length || (chosen.puts || []).length)) {
      return {
        ...chosen,
        expirationCandidates: ranked.slice(0, 4),
        expirationChoice: `在 ${ranked.slice(0, 4).map((row) => `${row.date}(${row.dte}天)`).join('、')} 中选 ${chosen.expiration}，目标约 ${TARGET_DTE} 天`
      };
    }
    last = chosen;
  }
  return last || { ...first, ok: false, error: '无符合期限的合约', calls: [], puts: [], expirationCandidates: ranked.slice(0, 4) };
}

export function vixValue(vix) {
  const last = Number(vix?.last ?? (typeof vix === 'number' ? vix : NaN));
  return vix?.ok !== false && last > 0 ? last : 'unknown';
}

export async function loadVix({ loader, quote } = {}) {
  if (!loader && !quote) {
    const hit = cacheGet('vix', 5 * 60 * 1000);
    if (hit) return hit;
  }
  const load = loader || ((symbol, opts) => loadChart(symbol, opts));
  const read = quote || fetchJson;
  let pack = { ok: false, last: null, source: null, status: 'unknown' };
  try {
    const chart = await load('^VIX', { range: '1mo', interval: '1d' });
    if (chart?.ok && Number(chart.last) > 0) {
      const prev = chart.bars?.at?.(-2)?.close;
      pack = {
        ok: true,
        last: Number(chart.last),
        change: prev > 0 ? Number(chart.last) - prev : null,
        source: chart.source || 'yahoo',
        status: 'known'
      };
    }
  } catch {
    pack = { ok: false, last: null, source: null, status: 'unknown' };
  }
  if (!pack.ok) {
    try {
      const json = await read('https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json', 8000);
      const last = num(json?.data?.current_price);
      if (last > 0) {
        pack = { ok: true, last, change: num(json?.data?.price_change), source: 'cboe', status: 'known' };
      }
    } catch {
      pack = { ok: false, last: null, source: null, status: 'unknown' };
    }
  }
  return loader || quote ? pack : cacheSet('vix', pack);
}

export async function loadSentiment(symbol) {
  const key = `tw:${symbol}`;
  const hit = cacheGet(key, 15 * 60 * 1000);
  if (hit) return hit;
  try {
    const json = await fetchJson(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, 8000);
    const msgs = json?.messages || [];
    let bull = 0;
    let bear = 0;
    for (const msg of msgs.slice(0, 40)) {
      const tag = String(msg?.entities?.sentiment?.basic || '').toLowerCase();
      if (tag === 'bullish') bull += 1;
      if (tag === 'bearish') bear += 1;
    }
    const tagged = bull + bear;
    return cacheSet(key, {
      ok: true,
      source: 'stocktwits',
      watchers: num(json?.symbol?.watchlist_count),
      messageCount: msgs.length,
      bull,
      bear,
      bullishPct: tagged ? (bull / tagged) * 100 : null,
      crowded: tagged >= 8 && (bull / tagged >= 0.85 || bear / tagged >= 0.85)
    });
  } catch (error) {
    return cacheSet(key, { ok: false, error: error.message, bullishPct: null, crowded: false });
  }
}

export async function mapPool(items, worker, { concurrency = 3 } = {}) {
  const out = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      out[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => run()));
  return out;
}

export async function loadEarnings(symbol, chain = {}, quote = {}, now = Date.now()) {
  const assetType = chain.assetType || quote.assetType;
  if (assetType === 'etf') return { status: 'not-applicable', date: null, source: chain.assetType ? chain.source : quote.source, checkedAt: now };
  const ts = [chain.earningsTs, quote.earningsTs].find(t => t > 0 && todayStamp(new Date(t * 1000)) >= todayStamp(new Date(now)));
  if (ts) return { status: 'estimated', date: todayStamp(new Date(ts * 1000)), timeKnown: false, source: 'yahoo', checkedAt: now };
  const key = `earnings:${symbol}`, cached = cacheGet(key, 3600000);
  if (cached && (!cached.date || cached.date >= todayStamp(new Date(now)))) return cached;
  try {
    const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-date`;
    const data = await fetchJson(url, 8000, NASDAQ_HEADERS);
    return cacheSet(key, { ...parseEarningsDate(data.data, now), source: 'nasdaq/zacks', checkedAt: now, sourceUrl: url });
  } catch { return cacheSet(key, { status: 'unknown', date: null, source: 'nasdaq/zacks', checkedAt: now, error: '备用财报来源暂不可用' }); }
}
