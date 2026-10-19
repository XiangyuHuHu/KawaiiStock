import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, ROOT, chinaStamp, isChinaSessionDay } from '../paths.js';
import { CN_PULLBACK } from './limit-pullback.js';

export const XIAOMENG_CN_FILE = join(ROOT, 'lists', 'cn', '小孟中小盘.md');
export const XIAOMENG_US_FILE = join(ROOT, 'lists', 'us', '小孟美股.md');
const ZT_DIR = join(DATA_DIR, 'paper', 'zt-pool');
const TICKER_RE = /\*\*([A-Z][A-Z0-9.-]{0,9})\*\*/g;

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

async function fetchLimitUpPool() {
  const url = 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc';
  const response = await fetch(url, {
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`涨停池 ${response.status}`);
  const parsed = limitUpRows(await response.json());
  if (!parsed.day) throw new Error('涨停池没有交易日');
  return parsed;
}

async function readPoolFile(day) {
  try {
    const json = JSON.parse(await readFile(join(ZT_DIR, `${day}.json`), 'utf8'));
    return Array.isArray(json.rows) ? json.rows : [];
  } catch {
    return [];
  }
}

async function cachedPoolDays(today, keep = 4) {
  let names = [];
  try {
    names = await readdir(ZT_DIR);
  } catch {
    return [];
  }
  return names
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((day) => day && day <= today && isChinaSessionDay(day))
    .sort()
    .slice(-keep);
}

/** 静态中小盘名单，加上本机留下的近期涨停快照。涨停池接口不返回历史日期，所以快照要靠每次纸上跑自己写。 */
export async function loadXiaomengCnUniverse({ now = new Date(), fetcher = fetchLimitUpPool } = {}) {
  const content = await readFile(XIAOMENG_CN_FILE, 'utf8');
  const staticLists = parseCnSectorMarkdown(content);
  const today = chinaStamp(now);
  const dynamic = { added: 0, days: [], error: null };
  try {
    const fresh = await fetcher();
    if (fresh?.day && fresh.rows) {
      await mkdir(ZT_DIR, { recursive: true });
      await writeFile(join(ZT_DIR, `${fresh.day}.json`), `${JSON.stringify({ day: fresh.day, rows: fresh.rows }, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    dynamic.error = error.message;
  }
  const days = await cachedPoolDays(today, 4);
  dynamic.days = days;
  const byIndustry = new Map();
  const seedCaps = {};
  for (const day of days) {
    for (const row of await readPoolFile(day)) {
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
