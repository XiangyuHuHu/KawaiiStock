import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, todayStamp } from './paths.js';
import { loadAccounts, loadHoldings } from './holdings.js';

const UA = 'Mozilla/5.0 (compatible; KawaiiResearchDesk/0.1)';
const CACHE_PATH = join(DATA_DIR, 'events-cache.json');
const CACHE_MS = 6 * 60 * 60 * 1000;
const SCAN_IDS = ['tactical', 'agentic'];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function addDays(stamp, delta) {
  const [y, m, d] = stamp.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + delta));
  return utc.toISOString().slice(0, 10);
}

function timingLabel(raw) {
  const text = String(raw || '').toLowerCase();
  if (text.includes('pre') || text === 'time-pre-market' || text === 'bmo' || text.includes('before')) return '盘前';
  if (text.includes('after') || text === 'time-after-hours' || text === 'amc' || text.includes('after')) return '盘后';
  if (text.includes('not-supplied') || text.includes('time-not')) return '时段未公布';
  return raw || '—';
}

async function fetchNasdaqEarnings(date) {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`earnings ${date} ${response.status}`);
  const json = await response.json();
  const rows = json?.data?.rows || json?.data?.earnings?.rows || [];
  return rows.map((row) => {
    const symbol = String(row.symbol || row.ticker || '').toUpperCase();
    return {
      date: row.date || row.lastYearRptDt || date,
      symbol,
      name: row.name || row.companyName || symbol,
      timing: timingLabel(row.time || row.earningsTime || row.hour),
      epsForecast: row.epsForecast || row.consensus_eps || null,
      fiscalQuarter: row.fiscalQuarterEnding || row.fiscalQuarter || null,
      source: 'nasdaq'
    };
  }).filter((row) => row.symbol);
}

async function loadCalendar(from, days, { refresh = false } = {}) {
  const cached = await readJson(CACHE_PATH);
  const age = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  if (!refresh && cached?.rows && age < CACHE_MS && cached.from === from && cached.days === days) {
    return { ...cached, cached: true };
  }
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const rows = [];
  const errors = [];
  for (const date of dates) {
    try {
      rows.push(...await fetchNasdaqEarnings(date));
    } catch (error) {
      errors.push({ date, error: error.message });
    }
  }
  const pack = {
    fetchedAt: new Date().toISOString(),
    from,
    days,
    rows,
    errors
  };
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CACHE_PATH, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  } catch {
    /* cache is optional */
  }
  return { ...pack, cached: false };
}

/** 未来 withinDays 个日历日内公布财报的代码 → 日期。拉不到日历返回空 Map，不挡推荐。 */
export async function upcomingEarnings(withinDays = 3) {
  const date = todayStamp();
  const limit = addDays(date, withinDays);
  const out = new Map();
  try {
    const calendar = await loadCalendar(date, 10);
    for (const row of calendar.rows || []) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(row.date || '') ? row.date : null;
      if (day && day >= date && day <= limit && !out.has(row.symbol)) out.set(row.symbol, day);
    }
  } catch {
    /* calendar optional */
  }
  return out;
}

export async function buildEventsDesk({ deskId = 'grok', days = 10, refresh = false } = {}) {
  const date = todayStamp();
  const config = await loadAccounts('grok');
  const watch = new Map();
  const expiries = [];

  for (const account of (config.accounts || []).filter((row) => SCAN_IDS.includes(row.id))) {
    const book = await loadHoldings(account);
    for (const pos of book.positions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!symbol || /ZZZ$/.test(symbol)) continue;
      const cur = watch.get(symbol) || { symbol, name: pos.name || symbol, accounts: [] };
      if (!cur.accounts.includes(account.id)) cur.accounts.push(account.id);
      watch.set(symbol, cur);
    }
    for (const pos of book.optionPositions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!symbol) continue;
      const cur = watch.get(symbol) || { symbol, name: symbol, accounts: [] };
      if (!cur.accounts.includes(account.id)) cur.accounts.push(account.id);
      watch.set(symbol, cur);
      if (pos.expiration) {
        expiries.push({
          date: String(pos.expiration).slice(0, 10),
          symbol,
          name: `${symbol} ${pos.expiration} ${pos.strike ?? ''} ${pos.type || ''}`.trim(),
          timing: '到期',
          kind: 'option-expiry',
          accounts: [account.id],
          accountLabel: account.short || account.label
        });
      }
    }
  }
  for (const symbol of config.focusTape || []) {
    const key = String(symbol || '').toUpperCase();
    if (!key || watch.has(key)) continue;
    watch.set(key, { symbol: key, name: key, accounts: ['tape'] });
  }

  let calendar = { rows: [], errors: [], cached: false };
  try {
    calendar = await loadCalendar(date, days, { refresh });
  } catch (error) {
    calendar = { rows: [], errors: [{ date, error: error.message }], cached: false };
  }

  const earnings = [];
  for (const row of calendar.rows || []) {
    const watched = watch.get(row.symbol);
    if (!watched) continue;
    earnings.push({
      ...row,
      date: row.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : date,
      kind: 'earnings',
      accounts: watched.accounts,
      name: watched.name || row.name
    });
  }

  const items = [...earnings, ...expiries]
    .filter((row) => row.date >= date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  const byAccount = { tactical: [], agentic: [] };
  for (const row of items) {
    for (const id of row.accounts || []) {
      if (byAccount[id]) byAccount[id].push(row);
    }
  }

  return {
    ok: true,
    liveTrading: false,
    draft: true,
    date,
    days,
    cached: Boolean(calendar.cached),
    note: '持仓和观察带上的财报/期权到期。不是下单，不进推荐/模拟/实际操作。',
    counts: {
      watched: watch.size,
      earnings: earnings.length,
      expiries: expiries.length,
      upcoming: items.length
    },
    errors: calendar.errors || [],
    items,
    byAccount
  };
}
