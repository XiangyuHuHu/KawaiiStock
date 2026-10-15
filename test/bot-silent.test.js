import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessHeartbeat } from '../src/bot/heartbeat.js';
import { renderListSummary } from '../src/bot/list-summary.js';
import { prefilterOptions } from '../src/bot/options-prefilter.js';
import { ackForumItems, BOX_FORUM_ROOT, BOX_LEDGER_DIR, runForumPrefetch } from '../src/bot/forum-prefetch.js';

const NOW = '2026-10-14T16:25:00.000Z';

function book(nav, positions) {
  return { routine: 'midday-7983', nav, positions };
}

test('midday stays silent when the NAV, stop, and position fingerprint is unchanged', () => {
  const snapshot = book(10000, [{ symbol: 'NVDA', qty: 10, last: 180, stop: 170 }]);
  const first = assessHeartbeat(snapshot, null, { now: NOW });
  assert.equal(first.fingerprint_unchanged, false);
  assert.equal(first.no_change, false);
  const marked = assessHeartbeat({ ...snapshot, positions: [{ symbol: 'NVDA', qty: 10, last: 181, stop: 170 }] }, first, { now: NOW });
  assert.equal(marked.fingerprint_unchanged, true);
  assert.equal(marked.no_change, true);
  assert.match(marked.reason, /指纹未变/);
  const nav = assessHeartbeat(book(10000.2, snapshot.positions), first, { now: NOW });
  assert.equal(nav.fingerprint_unchanged, false);
  assert.ok(nav.wakes.some((row) => row.code === 'fingerprint'));
  const sameCent = assessHeartbeat(book(10000, [{ symbol: 'NVDA', qty: 10, last: 179, stop: 170.004 }]), first, { now: NOW });
  assert.equal(sameCent.fingerprint_unchanged, true);
  assert.equal(sameCent.no_change, true);
  const stopMoved = assessHeartbeat(book(10000, [{ symbol: 'NVDA', qty: 10, last: 179, stop: 170.01 }]), first, { now: NOW });
  assert.equal(stopMoved.fingerprint_unchanged, false);
});

test('a new -7% alert wakes midday even when the fingerprint matches, and the same alert does not', () => {
  const down = book(10000, [{ symbol: 'MU', qty: 5, last: 90, prev: 100, stop: 80 }]);
  const first = assessHeartbeat(down, null);
  assert.ok(first.new_alerts.includes('MU'));
  const again = assessHeartbeat(down, first);
  assert.equal(again.fingerprint_unchanged, true);
  assert.deepEqual(again.new_alerts, []);
  assert.equal(again.no_change, true);
  const flat = assessHeartbeat(book(10000, [
    { symbol: 'MU', qty: 5, last: 100, stop: 80, changePct: -1 },
    { symbol: 'AMD', qty: 1, last: 100, stop: 80, changePct: -1 }
  ]), null);
  const dropped = assessHeartbeat(book(10000, [
    { symbol: 'MU', qty: 5, last: 100, stop: 80, changePct: -1 },
    { symbol: 'AMD', qty: 1, last: 100, stop: 80, changePct: -7.5 }
  ]), flat);
  assert.equal(dropped.fingerprint_unchanged, true);
  assert.deepEqual(dropped.new_alerts, ['AMD']);
  assert.equal(dropped.no_change, false);
  const sameBook = assessHeartbeat(book(10000, [
    { symbol: 'MU', qty: 5, last: 100, stop: 80, changePct: -1 },
    { symbol: 'AMD', qty: 1, last: 90, stop: 80, changePct: -7 }
  ]), null);
  const repeated = assessHeartbeat(book(10000, [
    { symbol: 'MU', qty: 5, last: 100, stop: 80, changePct: -1 },
    { symbol: 'AMD', qty: 1, last: 92, stop: 80, changePct: -9 }
  ]), sameBook);
  assert.equal(repeated.fingerprint_unchanged, true);
  assert.deepEqual(repeated.new_alerts, []);
  assert.equal(repeated.silent, true);
});

test('a state blob does not wake midday when the NAV, stop, and position fingerprint is unchanged', () => {
  const first = assessHeartbeat({ nav: 10000, positions: [], state: { orders: [{ id: 'a', qty: 1 }] } }, null);
  const same = assessHeartbeat({ nav: 10000, positions: [], state: { orders: [{ qty: 1, id: 'a' }] } }, first);
  assert.equal(same.no_change, true);
  const changed = assessHeartbeat({ nav: 10000, positions: [], state: { orders: [{ id: 'a', qty: 2 }] } }, first);
  assert.equal(changed.fingerprint_unchanged, true);
  assert.equal(changed.no_change, true);
  assert.equal(changed.wakes.some((row) => row.code === 'state-hash'), false);
});

test('list scan with nothing to promote, demote, or move is NO_CHANGE', () => {
  const summary = renderListSummary({ promote: [], demote: [], movers: [], scanned: 40 });
  assert.equal(summary.no_change, true);
  assert.equal(summary.text, 'NO_CHANGE');
});

test('list scan renders a fixed Chinese promote, demote, and mover string', () => {
  const scan = {
    promoted: [{ symbol: 'mu', from: 'watch', to: 'core' }],
    demote: ['OKLO'],
    moversDown: [{ ticker: 'SMCI', change_pct: -4.125 }],
    gainers: [{ symbol: 'NVDA', changePct: 3.2 }]
  };
  const summary = renderListSummary(scan);
  assert.equal(summary.no_change, false);
  assert.equal(summary.text, '【美股名单】\n升：MU 观察→核心\n降：OKLO\n异动：NVDA +3.20%；SMCI -4.13%');
  const repeat = renderListSummary(scan, summary);
  assert.equal(repeat.fingerprint_unchanged, true);
  assert.equal(repeat.text, 'NO_CHANGE');
  const added = renderListSummary({ ...scan, gainers: [{ symbol: 'NVDA', changePct: 3.2 }, { symbol: 'AVGO', changePct: 5 }] }, summary);
  assert.equal(added.silent, false);
  assert.match(added.text, /异动：AVGO \+5\.00%/);
  assert.doesNotMatch(added.text, /NVDA/);
});

test('options prefilter keeps contracts inside DTE, delta, and premium caps', () => {
  const pack = prefilterOptions({
    underlying: 'NVDA',
    spot: 180,
    calls: [
      { strike: 185, expiration: '2026-10-16', delta: 0.4, bid: 1.2, ask: 1.4 },
      { strike: 200, expiration: '2026-10-16', delta: 0.05, bid: 0.2, ask: 0.3 },
      { strike: 182, expiration: '2026-10-14', delta: 0.5, premium: 2 },
      { strike: 190, expiration: '2026-11-20', delta: 0.3, premium: 4 },
      { strike: 186, expiration: '2026-10-20', delta: -0.3, premium: 9, type: 'put' }
    ]
  }, { asOf: '2026-10-14' });
  assert.equal(pack.liveTrading, false);
  assert.equal(pack.orderPlacement, 'bot-and-connector-only');
  assert.equal(pack.empty_book, true);
  assert.equal(pack.trigger, true);
  assert.equal(pack.no_change, false);
  assert.equal(pack.candidates.length, 1);
  assert.equal(pack.candidates[0].expiration, '2026-10-16');
  assert.equal(pack.candidates[0].dte, 2);
  assert.equal(pack.candidates[0].premium, 1.3);
  assert.equal(pack.blockedShortDated.length, 1);
  assert.equal(pack.candidates.some((row) => row.dte <= 1), false);
  const again = prefilterOptions({
    underlying: 'NVDA',
    spot: 180,
    calls: [{ strike: 185, expiration: '2026-10-16', delta: 0.4, bid: 1.1, ask: 1.5 }]
  }, { asOf: '2026-10-14', previous: pack });
  assert.equal(again.fingerprint_unchanged, true);
  assert.equal(again.trigger, true);
  assert.equal(again.silent, true);
});

test('an empty 7983 book with no trigger is silent, and an open book change is not', () => {
  const empty = prefilterOptions({ contracts: [{ symbol: 'AMD', dte: 0, delta: 0.9, premium: 20 }] }, { asOf: '2026-10-14' });
  assert.equal(empty.empty_book, true);
  assert.equal(empty.trigger, false);
  assert.equal(empty.no_change, true);
  const open = prefilterOptions({
    book: [{ symbol: 'NVDA', qty: 1, type: 'call', strike: 185, expiration: '2026-10-16' }],
    contracts: []
  }, { asOf: '2026-10-14' });
  assert.equal(open.empty_book, false);
  assert.equal(open.trigger, false);
  assert.equal(open.fingerprint_unchanged, false);
  assert.equal(open.silent, false);
  const held = prefilterOptions({
    book: [{ symbol: 'NVDA', qty: 1, type: 'call', strike: 185, expiration: '2026-10-16' }],
    contracts: []
  }, { asOf: '2026-10-14', previous: open });
  assert.equal(held.fingerprint_unchanged, true);
  assert.equal(held.silent, true);
});

test('forum prefetch stays silent when the only new fingerprint is a quote band', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forum-scan-'));
  const news = { posts: [{ id: '99', author: 'desk', text: '$NVDA guide raised', createdAt: '2026-10-14T15:00:00Z' }] };
  const first = await runForumPrefetch({
    root,
    quotes: { NVDA: { last: 180, changePct: 0.2 } },
    xNews: news,
    events: { rows: [] },
    now: new Date('2026-10-15T06:00:00Z'),
    readmeText: '# contract\n'
  });
  assert.equal(first.silent, false);
  assert.equal(first.gate.newItems[0].kind, 'x-news');
  assert.equal(first.files.quotes.endsWith('.json'), true);
  assert.match(first.files.quotes, /quotes-/);
  assert.match(first.files.xNews, /x-news-/);
  assert.match(first.files.events, /events-/);
  const seen = JSON.parse(await readFile(first.files.seen, 'utf8'));
  assert.equal(Object.values(seen.fingerprints).some((row) => row.kind === 'x-news'), false);
  const second = await runForumPrefetch({
    root,
    quotes: { NVDA: { last: 181, changePct: 1.6 } },
    xNews: news,
    events: { rows: [{ symbol: 'AMD', date: '2026-10-16', kind: 'earnings', title: 'AMD earnings' }] },
    now: new Date('2026-10-15T06:05:00Z')
  });
  assert.equal(second.gate.newItems.some((row) => row.kind === 'quote'), false);
  assert.equal(second.gate.newItems.some((row) => row.kind === 'event'), true);
  const third = await runForumPrefetch({
    root,
    quotes: { NVDA: { last: 181.2, changePct: 1.4 } },
    xNews: news,
    events: { rows: [{ symbol: 'AMD', date: '2026-10-16', kind: 'earnings', title: 'AMD earnings' }] },
    now: new Date('2026-10-15T06:10:00Z')
  });
  assert.equal(third.silent, false);
  await ackForumItems({
    root,
    ledgerDir: root,
    now: new Date('2026-10-15T06:10:00Z'),
    items: third.gate.newItems.map((row) => ({ ...row, grade: 'A', line: `${row.symbol || 'NVDA'} 待看` }))
  });
  const quiet = await runForumPrefetch({
    root,
    quotes: { NVDA: { last: 181.3, changePct: 1.5 } },
    xNews: news,
    events: { rows: [{ symbol: 'AMD', date: '2026-10-16', kind: 'earnings', title: 'AMD earnings' }] },
    now: new Date('2026-10-15T06:15:00Z')
  });
  assert.equal(quiet.silent, true);
  assert.equal(quiet.gate.no_change, true);
  const ledger = await readFile(join(root, 'overheard-2026-10-14.md'), 'utf8');
  assert.match(ledger, /# Overheard 2026-10-14 PT/);
  assert.match(ledger, /## A/);
  const again = await ackForumItems({
    root,
    ledgerDir: root,
    now: new Date('2026-10-15T06:20:00Z'),
    items: [{ fingerprint: third.gate.newFingerprints[0], grade: 'A', line: '重复' }]
  });
  assert.equal(again.accepted.length, 0);
  const rejected = await ackForumItems({
    root,
    ledgerDir: join(root, 'empty'),
    items: [{ fingerprint: 'new-one', grade: 'C', line: '不要记' }]
  });
  assert.equal(rejected.ledger, null);
  await rm(root, { recursive: true, force: true });
});

test('box paths stay absolute and these scripts do not place orders', async () => {
  assert.equal(BOX_FORUM_ROOT, '/workspace/forum-scan');
  assert.equal(BOX_LEDGER_DIR, '/workspace');
  const contract = await readFile(new URL('../docs/forum-scan-prefetch.md', import.meta.url), 'utf8');
  const boxCopy = await readFile(new URL('../forum-scan/README.md', import.meta.url), 'utf8');
  assert.equal(boxCopy, contract);
  const sources = await Promise.all([
    'src/bot/heartbeat.js',
    'src/bot/main-trailing.js',
    'src/bot/list-summary.js',
    'src/bot/options-prefilter.js',
    'src/bot/forum-prefetch.js',
    'scripts/bot-heartbeat.js',
    'scripts/bot-list-summary.js',
    'scripts/bot-options-prefilter.js',
    'scripts/forum-prefetch.js'
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const joined = sources.join('\n');
  assert.equal(/robinhood|place_order|api\.robinhood|secret|private_key/i.test(joined), false);
});
