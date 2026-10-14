import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { todayStamp } from '../paths.js';
import { BOX_FORUM_ROOT, BOX_LEDGER_DIR, eventItems, newsItems, pacificParts, runForumPrefetch } from './forum-prefetch.js';

export const BOX_PLAYBOOK_ROOT = '/workspace/stock-playbook';
export const CHECKLIST_NAME = 'us-forum-event-checklist.json';
export const AGGREGATE_NAME = 'aggregate.json';
export const CHECKLIST_DAYS = 14;

const UA = 'Mozilla/5.0 (compatible; KawaiiResearchDesk/0.1)';
const SEC_UA = 'KawaiiResearchDesk/0.1 (forum-scan prefetch; research only; no trading)';

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const row of items) {
    if (!row?.fingerprint || seen.has(row.fingerprint)) continue;
    seen.add(row.fingerprint);
    out.push(row);
  }
  return out;
}

function addDays(stamp, delta) {
  const [y, m, d] = stamp.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + delta));
  return utc.toISOString().slice(0, 10);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlTag(block, name) {
  const match = String(block || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, ' ')) : '';
}

export function normalizeWatchlist(input = {}) {
  const rawSymbols = input.symbols || input.tickers || input.watch || [];
  const symbols = unique(rawSymbols.map((row) => String(row.symbol || row.ticker || row).replace(/^\$/, '').trim().toUpperCase()))
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol));
  const keywords = unique((input.keywords || []).map((row) => String(row || '').trim())).filter((row) => row.length >= 2);
  const cashtags = symbols.map((symbol) => `$${symbol}`);
  return { symbols, keywords, cashtags, queries: [...cashtags, ...keywords] };
}

export function fingerprintsInText(text) {
  return [...String(text || '').matchAll(/fp:([a-f0-9]{16,})/gi)].map((match) => match[1]);
}

export async function ledgerFingerprintSet(ledgerDir = BOX_LEDGER_DIR) {
  const found = new Set();
  let names = [];
  try {
    names = await readdir(ledgerDir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^overheard-\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const text = await readFile(join(ledgerDir, name), 'utf8');
    for (const fingerprint of fingerprintsInText(text)) found.add(fingerprint);
  }
  return found;
}

export function relevantToWatchlist(row, watch) {
  const symbols = new Set((row.symbols || [row.symbol]).filter(Boolean).map((symbol) => String(symbol).replace(/^\$/, '').toUpperCase()));
  if (watch.symbols.some((symbol) => symbols.has(symbol))) return true;
  const text = `${row.text || ''} ${row.title || ''} ${row.url || ''}`;
  const upper = text.toUpperCase();
  if (watch.cashtags.some((tag) => upper.includes(tag))) return true;
  const lower = text.toLowerCase();
  return watch.keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function headlinesFromRss(xml, symbol = null) {
  const out = [];
  for (const match of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = xmlTag(match[1], 'title');
    const link = xmlTag(match[1], 'link') || xmlTag(match[1], 'guid');
    const published = xmlTag(match[1], 'pubDate');
    const description = xmlTag(match[1], 'description');
    if (!title && !link) continue;
    out.push({
      id: link || null,
      title,
      text: [title, description].filter(Boolean).join(' — '),
      url: link || null,
      createdAt: published || null,
      symbols: symbol ? [symbol] : [],
      source: 'yahoo-rss'
    });
  }
  return out.slice(0, 20);
}

export function yahooQuoteFromChart(symbol, json) {
  const meta = json?.chart?.result?.[0]?.meta || {};
  const last = num(meta.regularMarketPrice);
  const prev = num(meta.chartPreviousClose ?? meta.previousClose);
  if (!(last > 0)) return { symbol, ok: false, source: 'yahoo', error: 'empty' };
  return {
    symbol,
    ok: true,
    source: 'yahoo',
    last,
    prev,
    changePct: prev > 0 ? ((last - prev) / prev) * 100 : null
  };
}

export function robinhoodQuoteRequest(symbols) {
  const list = unique(symbols.map((symbol) => String(symbol || '').toUpperCase()));
  return {
    url: `https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(list.join(','))}`,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  };
}

export function robinhoodQuotesFromPayload(json) {
  return (json?.results || json?.quotes || []).map((row) => {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const last = num(row.last_trade_price ?? row.lastTradePrice ?? row.last);
    const prev = num(row.previous_close ?? row.previousClose);
    if (!symbol || !(last > 0)) return null;
    return {
      symbol,
      ok: true,
      source: 'robinhood',
      last,
      prev,
      bid: num(row.bid_price ?? row.bidPrice),
      ask: num(row.ask_price ?? row.askPrice),
      changePct: prev > 0 ? ((last - prev) / prev) * 100 : null
    };
  }).filter(Boolean);
}

export function mergeQuotes(primary = [], secondary = []) {
  const by = new Map();
  for (const row of primary) {
    if (!row?.symbol) continue;
    by.set(row.symbol, { ...row, sources: row.ok ? [row.source] : [] });
  }
  for (const row of secondary) {
    if (!row?.symbol) continue;
    const current = by.get(row.symbol) || { symbol: row.symbol, ok: false, sources: [] };
    by.set(row.symbol, {
      ...current,
      ok: Boolean(current.ok || row.ok),
      last: current.last ?? row.last,
      prev: current.prev ?? row.prev,
      changePct: current.changePct ?? row.changePct,
      robinhoodLast: row.source === 'robinhood' ? row.last : current.robinhoodLast ?? null,
      sources: unique([...(current.sources || []), row.ok ? row.source : null])
    });
  }
  return [...by.values()];
}

export function cikByTicker(tickersJson) {
  const map = new Map();
  for (const row of Object.values(tickersJson || {})) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker || row.cik_str == null) continue;
    map.set(ticker, String(row.cik_str).padStart(10, '0'));
  }
  return map;
}

export function filingsFromSubmission(symbol, cik, json, { from, lookbackStart }) {
  const recent = json?.filings?.recent || {};
  const forms = recent.form || [];
  const dates = recent.filingDate || [];
  const accessions = recent.accessionNumber || [];
  const docs = recent.primaryDocument || [];
  const descriptions = recent.primaryDocDescription || [];
  const cikInt = String(parseInt(cik, 10));
  const out = [];
  for (let i = 0; i < forms.length; i += 1) {
    const form = String(forms[i] || '');
    const kind = form.startsWith('8-K') ? '8-k' : (form === '4' || form.startsWith('4/')) ? 'form4' : null;
    if (!kind) continue;
    const date = String(dates[i] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < lookbackStart || date > from) continue;
    const accession = String(accessions[i] || '');
    const doc = String(docs[i] || '');
    const url = accession && doc
      ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession.replaceAll('-', '')}/${doc}`
      : null;
    out.push({
      symbol,
      date,
      kind,
      title: `${symbol} ${form} ${descriptions[i] || ''}`.trim(),
      url,
      accession: accession || null,
      source: 'edgar'
    });
  }
  return out;
}

export function checklistEarnings(rows, symbols, from, to) {
  const wanted = new Set(symbols);
  return (rows || []).filter((row) => wanted.has(String(row.symbol || '').toUpperCase()) && row.date >= from && row.date <= to)
    .map((row) => {
    const symbol = String(row.symbol).toUpperCase();
    return {
      symbol,
      date: row.date,
      kind: 'earnings',
      title: `${symbol} 财报 ${row.timing || row.time || ''}`.trim(),
      timing: row.timing || row.time || null,
      source: row.source || 'nasdaq'
    };
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        out[current] = await fn(items[current]);
      } catch (error) {
        out[current] = { ok: false, error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, () => worker()));
  return out;
}

async function getText(fetcher, url, headers) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function getJson(fetcher, url, headers) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export async function gatherPublicSources({
  watch,
  from,
  days = CHECKLIST_DAYS,
  fetcher = fetch,
  fixtures = null
} = {}) {
  if (fixtures) return { ...fixtures, errors: fixtures.errors || [] };
  const errors = [];
  const to = addDays(from, days - 1);
  const lookbackStart = addDays(from, -(days - 1));
  const quoteRows = await pool(watch.symbols, 4, async (symbol) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d&includePrePost=false`;
      const json = await getJson(fetcher, url, { Accept: 'application/json', 'User-Agent': UA });
      return yahooQuoteFromChart(symbol, json);
    } catch (error) {
      return { symbol, ok: false, source: 'yahoo', error: error.message };
    }
  });
  for (const row of quoteRows) {
    if (row?.ok === false) errors.push({ source: 'yahoo-quotes', symbol: row.symbol || null, error: row.error || 'empty' });
  }
  let robinhood = [];
  if (watch.symbols.length) {
    const request = robinhoodQuoteRequest(watch.symbols);
    try {
      const json = await getJson(fetcher, request.url, request.headers);
      robinhood = robinhoodQuotesFromPayload(json);
    } catch (error) {
      errors.push({ source: 'robinhood-quotes', error: error.message });
    }
  }
  const headlines = [];
  const rssRows = await pool(watch.symbols, 3, async (symbol) => {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    const xml = await getText(fetcher, url, { Accept: 'application/rss+xml', 'User-Agent': UA });
    return headlinesFromRss(xml, symbol);
  });
  for (const row of rssRows) {
    if (Array.isArray(row)) headlines.push(...row);
    else if (row?.error) errors.push({ source: 'yahoo-rss', error: row.error });
  }
  const earnings = [];
  const earningDays = await pool(Array.from({ length: days }, (_, i) => addDays(from, i)), 3, async (date) => {
    const url = `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`;
    const json = await getJson(fetcher, url, { Accept: 'application/json', 'User-Agent': UA });
    const rows = json?.data?.rows || json?.data?.earnings?.rows || [];
    return rows.map((row) => ({
      date,
      symbol: String(row.symbol || row.ticker || '').toUpperCase(),
      timing: row.time || row.earningsTime || null,
      source: 'nasdaq'
    })).filter((row) => row.symbol);
  });
  for (const row of earningDays) {
    if (Array.isArray(row)) earnings.push(...row);
    else if (row?.error) errors.push({ source: 'nasdaq-earnings', error: row.error });
  }
  let tickers = null;
  try {
    tickers = await getJson(fetcher, 'https://www.sec.gov/files/company_tickers.json', { Accept: 'application/json', 'User-Agent': SEC_UA });
  } catch (error) {
    errors.push({ source: 'edgar-tickers', error: error.message });
  }
  const cik = cikByTicker(tickers);
  const submissions = {};
  const filingRows = await pool(watch.symbols, 2, async (symbol) => {
    const id = cik.get(symbol);
    if (!id) return { symbol, error: 'cik-missing' };
    const json = await getJson(fetcher, `https://data.sec.gov/submissions/CIK${id}.json`, { Accept: 'application/json', 'User-Agent': SEC_UA });
    submissions[symbol] = json;
    return filingsFromSubmission(symbol, id, json, { from, lookbackStart });
  });
  const filings = [];
  for (const row of filingRows) {
    if (Array.isArray(row)) filings.push(...row);
    else if (row?.error) errors.push({ source: 'edgar', symbol: row.symbol, error: row.error });
  }
  return { quotes: mergeQuotes(quoteRows.filter((row) => row?.symbol), robinhood), headlines, earnings, filings, errors, from, to, lookbackStart };
}

function quoteFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
  if (!symbol) return null;
  const chart = yahooQuoteFromChart(symbol, { chart: { result: [{ meta: row.meta || row }] } });
  if (chart.ok) return chart;
  const last = num(row.last ?? row.price);
  const changePct = num(row.changePct);
  if (!(last > 0) && changePct == null) return { symbol, ok: false, source: row.source || 'dump', error: 'empty' };
  return { symbol, ok: last > 0, source: row.source || 'yahoo', last, changePct, prev: num(row.prev) };
}

function dumpQuotes(dump) {
  if (!dump) return [];
  const rows = Array.isArray(dump) ? dump : (dump.quotes || dump.items || []);
  return rows.map(quoteFromRow).filter(Boolean);
}

export async function refreshForumAggregate({
  watchlist = {},
  xNews = null,
  ledgerDir = BOX_LEDGER_DIR,
  root = BOX_FORUM_ROOT,
  now = new Date(),
  days = CHECKLIST_DAYS,
  fetcher = fetch,
  fixtures = null,
  offline = false,
  readmeText = ''
} = {}) {
  const stamp = now instanceof Date ? now : new Date(now);
  const watch = normalizeWatchlist(watchlist);
  const from = todayStamp(stamp);
  const to = addDays(from, days - 1);
  const lookbackStart = addDays(from, -(days - 1));
  const errors = [];
  let sources;
  if (offline || fixtures) {
    sources = {
      quotes: mergeQuotes(dumpQuotes(fixtures?.quotes), robinhoodQuotesFromPayload(fixtures?.robinhood || {})),
      headlines: fixtures?.headlines || [],
      earnings: fixtures?.earnings || [],
      filings: fixtures?.filings || [],
      errors: fixtures?.errors || []
    };
    if (fixtures?.rss) {
      for (const [symbol, xml] of Object.entries(fixtures.rss)) sources.headlines.push(...headlinesFromRss(xml, symbol));
    }
    if (fixtures?.tickers && fixtures?.submissions) {
      const cik = cikByTicker(fixtures.tickers);
      for (const symbol of watch.symbols) {
        const id = cik.get(symbol);
        if (!id || !fixtures.submissions[symbol]) continue;
        sources.filings.push(...filingsFromSubmission(symbol, id, fixtures.submissions[symbol], { from, lookbackStart }));
      }
    }
  } else {
    sources = await gatherPublicSources({ watch, from, days, fetcher });
  }
  errors.push(...(sources.errors || []));
  const xDump = newsItems(xNews).map((row) => ({ ...row, source: row.source || 'x-dump' }));
  const rssNews = newsItems({ items: (sources.headlines || []).filter((row) => relevantToWatchlist(row, watch)) });
  const watchedNews = dedupeItems([...rssNews, ...xDump.filter((row) => relevantToWatchlist(row, watch))]);
  const checklistRows = [
    ...checklistEarnings(sources.earnings || [], watch.symbols, from, to),
    ...(sources.filings || []).filter((row) => watch.symbols.includes(row.symbol))
  ];
  const checklistItems = dedupeItems(eventItems({ items: checklistRows }));
  const ledger = await ledgerFingerprintSet(ledgerDir);
  const known = new Set(ledger);
  const freshNews = watchedNews.filter((row) => !known.has(row.fingerprint));
  const freshEvents = checklistItems.filter((row) => !known.has(row.fingerprint));
  const duplicateCount = (watchedNews.length - freshNews.length) + (checklistItems.length - freshEvents.length);
  const { gate, files } = await runForumPrefetch({
    root,
    now: stamp,
    readmeText,
    extraKnown: [...known],
    quotes: { items: sources.quotes || [] },
    xNews: { items: freshNews },
    events: { items: freshEvents.map((row) => ({ ...row, kind: row.eventKind, title: row.title })) }
  });
  const checklist = {
    version: 1,
    liveTrading: false,
    name: CHECKLIST_NAME,
    generatedAt: stamp.toISOString(),
    timezone: 'America/New_York',
    window: { from, to, lookbackStart, days },
    symbols: watch.symbols,
    queries: watch.queries,
    items: checklistItems.map((row) => ({
      ...row,
      new: !known.has(row.fingerprint)
    })),
    errors,
    note: '14 日盘前清单：未来窗口内的财报，以及回看窗口内的 Form 4 / 8-K。不是下单，也不代替 A/B。'
  };
  const checklistPath = join(root, 'state', CHECKLIST_NAME);
  const aggregatePath = join(root, 'state', AGGREGATE_NAME);
  const aggregate = {
    version: 1,
    liveTrading: false,
    generatedAt: stamp.toISOString(),
    ptDate: pacificParts(stamp).date,
    silent: gate.silent,
    no_change: gate.no_change,
    newCount: gate.newCount,
    newFingerprints: gate.newFingerprints,
    newItems: gate.newItems,
    duplicateCount,
    ledgerFingerprints: ledger.size,
    queries: watch,
    checklist: checklistPath,
    prefetch: gate.prefetch,
    quotes: (sources.quotes || []).map((row) => ({
      symbol: row.symbol,
      ok: row.ok,
      last: row.last ?? null,
      changePct: row.changePct ?? null,
      sources: row.sources || [row.source].filter(Boolean),
      robinhoodLast: row.robinhoodLast ?? null
    })),
    errors,
    instruction: gate.silent
      ? '相对 overheard 账本没有新指纹。不要呼叫模型，不要做网页检索，不要分类 A/B。'
      : '只对 newFingerprints 分类 A 或 B。不要再搜 X、新闻、EDGAR 或财报日历。'
  };
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(checklistPath, `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  let playbookChecklist = null;
  let playbookAggregate = null;
  if (root === BOX_FORUM_ROOT) {
    const state = join(BOX_PLAYBOOK_ROOT, 'state');
    await mkdir(state, { recursive: true });
    playbookChecklist = join(state, CHECKLIST_NAME);
    playbookAggregate = join(state, AGGREGATE_NAME);
    await writeFile(playbookChecklist, `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');
    await writeFile(playbookAggregate, `${JSON.stringify({ ...aggregate, checklist: playbookChecklist }, null, 2)}\n`, 'utf8');
  }
  return { aggregate, checklist, gate, files, silent: gate.silent, playbookChecklist, playbookAggregate };
}
