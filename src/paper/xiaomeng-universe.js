import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, ROOT, chinaStamp, isChinaSessionDay } from '../paths.js';
import { CN_PULLBACK } from './limit-pullback.js';

export const XIAOMENG_CN_FILE = join(ROOT, 'lists', 'cn', '小孟中小盘.md');
export const XIAOMENG_US_FILE = join(ROOT, 'lists', 'us', '小孟美股.md');
const TICKER_RE = /\*\*([A-Z][A-Z0-9.-]{0,9})\*\*/g;

export function limitUpPoolQueryDate(now = new Date()) {
  return chinaStamp(now).replaceAll('-', '');
}

/** 不带 date 时东财返回 rc=102、data=null。date 只用当天北京日历日，更早的日期它不给。 */
export function limitUpPoolUrl(now = new Date()) {
  const date = limitUpPoolQueryDate(now);
  return `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${date}`;
}

export function parseCnSectorMarkdown(content) {
  const lists = [];
  let current = null;
  for (const line of String(content || '').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1].trim(), stocks: [] };
      lists.push(current);
      continue;
    }
    const row = line.match(/^\|\s*(\d{6})\s*\|\s*([^|]+?)\s*\|/);
    if (!row || !current) continue;
    const symbol = row[1];
    const company = row[2].trim();
    if (company === '名称' || company.includes('---')) continue;
    if (current.stocks.some((stock) => stock.symbol === symbol)) continue;
    current.stocks.push({ symbol, company });
  }
  return lists.filter((list) => list.stocks.length);
}

export function parseUsSectorMarkdown(content) {
  const lists = [];
  let current = null;
  for (const line of String(content || '').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1].trim(), symbols: [] };
      lists.push(current);
      continue;
    }
    if (!current) continue;
    for (const match of line.matchAll(TICKER_RE)) {
      const symbol = match[1];
      if (!current.symbols.includes(symbol)) current.symbols.push(symbol);
    }
  }
  return lists.filter((list) => list.symbols.length);
}

export function indexSectorLists(lists, { symbolKey = 'stocks' } = {}) {
  const listOf = {};
  const members = {};
  const companies = {};
  for (const list of lists || []) {
    members[list.title] = [];
    const rows = symbolKey === 'symbols'
      ? (list.symbols || []).map((symbol) => ({ symbol, company: '' }))
      : (list.stocks || []);
    for (const row of rows) {
      const symbol = String(row.symbol || '');
      if (!symbol) continue;
      companies[symbol] = row.company || companies[symbol] || '';
      if (!listOf[symbol]) listOf[symbol] = [];
      if (!listOf[symbol].includes(list.title)) listOf[symbol].push(list.title);
      if (!members[list.title].includes(symbol)) members[list.title].push(symbol);
    }
  }
  return { listOf, members, companies, symbols: Object.keys(listOf) };
}

function stampFromQdate(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function inFloatBand(cap) {
  return cap >= CN_PULLBACK.minFloat && cap <= CN_PULLBACK.maxFloat;
}

export function limitUpRows(payload) {
  const pool = payload?.data?.pool || payload?.pool || [];
  const day = stampFromQdate(payload?.data?.qdate || payload?.qdate);
  const rows = [];
  for (const row of pool) {
    const symbol = String(row.c || row.symbol || '').padStart(6, '0');
    if (!/^\d{6}$/.test(symbol)) continue;
    const company = String(row.n || row.company || '');
    if (/ST/i.test(company)) continue;
    const floatCap = Number(row.ltsz || row.floatCap);
    if (!inFloatBand(floatCap)) continue;
    rows.push({
      symbol,
      company,
      industry: String(row.hybk || row.industry || '其他').trim() || '其他',
      floatCap,
      boards: Number(row.lbc) || null
    });
  }
  return { day, rows };
}

export function parseLimitUpPool(json, requestedDate) {
  const date = String(requestedDate || '').replaceAll('-', '');
  if (json?.data == null || (json?.rc != null && json.rc !== 0)) {
    throw new Error(`涨停池 rc=${json?.rc ?? 'missing'}，date=${date || 'missing'}`);
  }
  const parsed = limitUpRows(json);
  if (!parsed.day) throw new Error(`涨停池没有交易日 date=${date || 'missing'}`);
  if (date && parsed.day.replaceAll('-', '') !== date) {
    throw new Error(`涨停池交易日 ${parsed.day} 不是请求的 ${date}`);
  }
  return parsed;
}

async function fetchLimitUpPool(now = new Date()) {
  const date = limitUpPoolQueryDate(now);
  const response = await fetch(limitUpPoolUrl(now), {
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`涨停池 ${response.status}，date=${date}`);
  return parseLimitUpPool(await response.json(), date);
}

async function readPoolFile(dir, day) {
  try {
    const json = JSON.parse(await readFile(join(dir, `${day}.json`), 'utf8'));
    return Array.isArray(json.rows) ? json.rows : [];
  } catch {
    return [];
  }
}

async function cachedPoolDays(dir, today, keep = 4) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((day) => day && day <= today && isChinaSessionDay(day))
    .sort()
    .slice(-keep);
}

/** 静态中小盘名单，加上本机留下的近期涨停快照。涨停池只认当天北京日期，更早的日子靠已经写下的快照。 */
export async function loadXiaomengCnUniverse({ now = new Date(), fetcher = fetchLimitUpPool, poolDir = join(DATA_DIR, 'paper', 'zt-pool') } = {}) {
  const content = await readFile(XIAOMENG_CN_FILE, 'utf8');
  const staticLists = parseCnSectorMarkdown(content);
  const today = chinaStamp(now);
  const dynamic = { added: 0, days: [], error: null, requestedDate: limitUpPoolQueryDate(now) };
  try {
    const fresh = await fetcher(now);
    if (fresh?.day && Array.isArray(fresh.rows)) {
      await mkdir(poolDir, { recursive: true });
      await writeFile(join(poolDir, `${fresh.day}.json`), `${JSON.stringify({ day: fresh.day, rows: fresh.rows }, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    dynamic.error = error.message;
  }
  const days = await cachedPoolDays(poolDir, today, 4);
  dynamic.days = days;
  const byIndustry = new Map();
  const seedCaps = {};
  for (const day of days) {
    for (const row of await readPoolFile(poolDir, day)) {
      if (!inFloatBand(row.floatCap)) continue;
      seedCaps[row.symbol] = row.floatCap;
      const title = `涨停:${row.industry || '其他'}`;
      if (!byIndustry.has(title)) byIndustry.set(title, new Map());
      byIndustry.get(title).set(row.symbol, row.company || '');
    }
  }
  const dynamicLists = [...byIndustry.entries()].map(([title, names]) => ({
    title,
    stocks: [...names.entries()].map(([symbol, company]) => ({ symbol, company }))
  }));
  dynamic.added = dynamicLists.reduce((sum, list) => sum + list.stocks.length, 0);
  const lists = [...staticLists, ...dynamicLists];
  return {
    ...indexSectorLists(lists),
    lists,
    seedCaps,
    universe: {
      file: 'lists/cn/小孟中小盘.md',
      staticSymbols: staticLists.reduce((sum, list) => sum + list.stocks.length, 0),
      staticLists: staticLists.length,
      dynamic
    }
  };
}

export async function loadXiaomengUsFallback() {
  const content = await readFile(XIAOMENG_US_FILE, 'utf8');
  const lists = parseUsSectorMarkdown(content);
  return {
    ...indexSectorLists(lists, { symbolKey: 'symbols' }),
    lists,
    universe: {
      file: 'lists/us/小孟美股.md',
      symbols: lists.reduce((sum, list) => sum + list.symbols.length, 0),
      lists: lists.length,
      fallback: true
    }
  };
}
