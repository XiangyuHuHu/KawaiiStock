import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './hash.js';

export const BOX_FORUM_ROOT = '/workspace/forum-scan';
export const BOX_LEDGER_DIR = '/workspace';
export const WAKE_KINDS = ['x-news', 'event'];

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function pacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((row) => row.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  };
}

export function overheardPath(ledgerDir, date) {
  return join(ledgerDir, `overheard-${date}.md`);
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function itemsOf(dump, keys) {
  if (Array.isArray(dump)) return dump;
  if (!dump || typeof dump !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(dump[key])) return dump[key];
  }
  return [];
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cashtags(text) {
  return [...new Set([...String(text || '').matchAll(/\$([A-Za-z]{1,5})\b/g)].map((match) => match[1].toUpperCase()))];
}

export function quoteItems(dump, { bandPct = 1, ptDate }) {
  const rows = [];
  if (Array.isArray(dump)) rows.push(...dump);
  else if (dump && typeof dump === 'object') {
    rows.push(...asArray(dump.items), ...asArray(dump.quotes));
    for (const [symbol, row] of Object.entries(dump)) {
      if (['items', 'quotes', 'version', 'kind', 'generatedAt', 'source'].includes(symbol)) continue;
      if (row && typeof row === 'object') rows.push({ symbol, ...row });
    }
  }
  const out = [];
  for (const row of rows) {
    const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
    if (!symbol) continue;
    const changePct = num(row.changePct ?? row.pct ?? row.change_pct);
    const band = changePct == null ? 'na' : String(Math.round(changePct / bandPct));
    const fingerprint = sha256(`quote|${symbol}|${ptDate}|${band}`);
    out.push({
      kind: 'quote',
      symbol,
      last: num(row.last ?? row.price ?? row.mark),
      changePct,
      band,
      fingerprint,
      wakes: false
    });
  }
  const seen = new Set();
  return out.filter((row) => {
    if (seen.has(row.fingerprint)) return false;
    seen.add(row.fingerprint);
    return true;
  });
}

export function newsItems(dump) {
  return itemsOf(dump, ['items', 'posts', 'news']).map((row) => {
    const text = clean(row.text || row.full_text || row.title || '');
    const author = clean(row.author || row.username || row.user?.screen_name || row.user?.username || '');
    const id = clean(row.id || row.id_str || row.rest_id || '');
    const createdAt = clean(row.createdAt || row.created_at || '');
    const symbols = [...new Set([
      ...asArray(row.symbols || row.cashtags).map((symbol) => String(symbol).replace(/^\$/, '').toUpperCase()),
      ...cashtags(text)
    ].filter(Boolean))];
    const material = id ? `id:${id}` : `${author.toLowerCase()}|${createdAt}|${text}`;
    return {
      kind: 'x-news',
      id: id || null,
      author: author || null,
      text,
      url: clean(row.url || '') || null,
      createdAt: createdAt || null,
      symbols,
      fingerprint: sha256(`x-news|${material}`),
      wakes: true
    };
  }).filter((row) => row.id || row.text);
}

export function eventItems(dump) {
  return itemsOf(dump, ['items', 'events', 'rows']).map((row) => {
    const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
    const date = String(row.date || row.when || '').slice(0, 10);
    const eventKind = clean(row.kind || row.type || 'event') || 'event';
    const title = clean(row.title || row.name || row.summary || '');
    const fingerprint = sha256(`event|${symbol}|${date}|${eventKind}|${title}`);
    return {
      kind: 'event',
      symbol: symbol || null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      eventKind,
      title,
      fingerprint,
      wakes: true
    };
  }).filter((row) => row.symbol || row.title);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function emptySeen(now) {
  return { version: 1, updatedAt: now, fingerprints: {} };
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function envelope(kind, items, now, source) {
  return {
    version: 1,
    kind,
    generatedAt: now,
    liveTrading: false,
    source,
    items
  };
}

export async function runForumPrefetch({
  root = BOX_FORUM_ROOT,
  quotes = null,
  xNews = null,
  events = null,
  now = new Date(),
  readmeText = '',
  quoteBandPct = 1,
  wakeKinds = WAKE_KINDS
} = {}) {
  const stamp = now instanceof Date ? now : new Date(now);
  const iso = stamp.toISOString();
  const ptDate = pacificParts(stamp).date;
  const quotesList = quoteItems(quotes, { bandPct: quoteBandPct, ptDate });
  const newsList = newsItems(xNews);
  const eventList = eventItems(events);
  const prefetchDir = join(root, 'prefetch');
  const stateDir = join(root, 'state');
  const name = fileStamp(stamp);
  const files = {
    quotes: join(prefetchDir, `quotes-${name}.json`),
    xNews: join(prefetchDir, `x-news-${name}.json`),
    events: join(prefetchDir, `events-${name}.json`),
    seen: join(stateDir, 'seen-fingerprints.json'),
    gate: join(stateDir, 'gate.json'),
    readme: join(root, 'README.md')
  };
  const seen = await readJson(files.seen) || emptySeen(iso);
  if (!seen.fingerprints || typeof seen.fingerprints !== 'object') seen.fingerprints = {};
  const known = new Set(Object.keys(seen.fingerprints));
  const wake = new Set(wakeKinds);
  const fresh = [...newsList, ...eventList, ...quotesList].filter((row) => !known.has(row.fingerprint));
  for (const row of quotesList) {
    if (!seen.fingerprints[row.fingerprint]) {
      seen.fingerprints[row.fingerprint] = { kind: 'quote', firstSeenAt: iso, ackedAt: iso, grade: null };
    }
  }
  const newItems = fresh.filter((row) => wake.has(row.kind));
  const silent = newItems.length === 0;
  const gate = {
    version: 1,
    silent,
    no_change: silent,
    newCount: newItems.length,
    newFingerprints: newItems.map((row) => row.fingerprint),
    newItems: newItems.map((row) => ({
      fingerprint: row.fingerprint,
      kind: row.kind,
      symbol: row.symbol || row.symbols?.[0] || null,
      text: (row.text || row.title || '').slice(0, 240)
    })),
    prefetch: { quotes: files.quotes, xNews: files.xNews, events: files.events },
    instruction: silent
      ? '没有新指纹。不要呼叫模型，不要分类 A/B，不要写 overheard。'
      : '只阅读 prefetch 里 newFingerprints 对应的条目并分类 A 或 B，然后用 --ack 记账。'
  };
  seen.updatedAt = iso;
  seen.lastRun = {
    silent,
    no_change: silent,
    newFingerprints: gate.newFingerprints,
    prefetch: gate.prefetch
  };
  await writeJson(files.quotes, envelope('quotes', quotesList, iso, quotes ? 'dump' : 'none'));
  await writeJson(files.xNews, envelope('x-news', newsList, iso, xNews ? 'dump' : 'none'));
  await writeJson(files.events, envelope('events', eventList, iso, events ? 'dump' : 'none'));
  await writeJson(files.seen, seen);
  await writeJson(files.gate, gate);
  if (readmeText) await writeFile(files.readme, readmeText.endsWith('\n') ? readmeText : `${readmeText}\n`, 'utf8');
  return { gate, files, silent };
}

function ledgerSkeleton(date) {
  return `# Overheard ${date} PT

论坛扫描。A 值得看，B 记下即可。没有新指纹时不要追加，也不要呼叫模型。

## A

## B
`;
}

function insertBullet(text, grade, bullet) {
  const heading = `## ${grade}`;
  const index = text.indexOf(heading);
  if (index < 0) return `${text.trimEnd()}\n\n${heading}\n${bullet}\n`;
  const after = index + heading.length;
  const next = text.indexOf('\n## ', after);
  const end = next < 0 ? text.length : next;
  const block = text.slice(after, end).replace(/\s*$/, '');
  return `${text.slice(0, after)}${block}\n${bullet}\n${next < 0 ? '' : text.slice(end)}`;
}

export async function ackForumItems({
  root = BOX_FORUM_ROOT,
  ledgerDir = BOX_LEDGER_DIR,
  items = [],
  now = new Date()
} = {}) {
  const stamp = now instanceof Date ? now : new Date(now);
  const iso = stamp.toISOString();
  const pt = pacificParts(stamp);
  const seenPath = join(root, 'state', 'seen-fingerprints.json');
  const seen = await readJson(seenPath) || emptySeen(iso);
  if (!seen.fingerprints || typeof seen.fingerprints !== 'object') seen.fingerprints = {};
  const ledgerFile = overheardPath(ledgerDir, pt.date);
  let ledger = null;
  try {
    ledger = await readFile(ledgerFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let text = ledger || ledgerSkeleton(pt.date);
  const accepted = [];
  const skipped = [];
  for (const row of items) {
    const fingerprint = String(row.fingerprint || '');
    const grade = String(row.grade || '').toUpperCase();
    if (!fingerprint || (grade !== 'A' && grade !== 'B')) {
      skipped.push({ fingerprint, reason: 'grade-must-be-A-or-B' });
      continue;
    }
    const prior = seen.fingerprints[fingerprint];
    if (prior?.ackedAt && prior.grade) {
      skipped.push({ fingerprint, reason: 'already-acked' });
      continue;
    }
    const line = clean(row.line || row.text || row.symbol || fingerprint);
    const bullet = `- ${pt.time} PT · ${line} <!-- fp:${fingerprint} -->`;
    if (!text.includes(`fp:${fingerprint}`)) text = insertBullet(text, grade, bullet);
    seen.fingerprints[fingerprint] = {
      kind: prior?.kind || row.kind || 'x-news',
      firstSeenAt: prior?.firstSeenAt || iso,
      ackedAt: iso,
      grade
    };
    accepted.push({ fingerprint, grade });
  }
  if (accepted.length) {
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(ledgerFile, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }
  seen.updatedAt = iso;
  await writeJson(seenPath, seen);
  return {
    liveTrading: false,
    accepted,
    skipped,
    ledger: accepted.length ? ledgerFile : null,
    silent: accepted.length === 0
  };
}
