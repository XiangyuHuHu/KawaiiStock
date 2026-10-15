import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessHeartbeat } from '../src/bot/heartbeat.js';
import { prefilterOptions } from '../src/bot/options-prefilter.js';

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

test('heartbeat and the 7811 observer do not place orders', async () => {
  const sources = await Promise.all([
    'src/bot/hash.js',
    'src/bot/heartbeat.js',
    'src/bot/main-trailing.js',
    'src/bot/options-prefilter.js',
    'scripts/bot-heartbeat.js'
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const joined = sources.join('\n');
  assert.equal(/robinhood|place_order|api\.robinhood|secret|private_key/i.test(joined), false);
  assert.match(joined, /liveTrading: false/);
  assert.match(joined, /data\/bot\/main-trailing\.json/);
});
