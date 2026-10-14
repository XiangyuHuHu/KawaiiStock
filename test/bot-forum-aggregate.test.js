import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newsItems } from '../src/bot/forum-prefetch.js';
import {
  filingsFromSubmission,
  fingerprintsInText,
  headlinesFromRss,
  refreshForumAggregate,
  robinhoodQuoteRequest,
  yahooQuoteFromChart
} from '../src/bot/forum-aggregate.js';

const NOW = new Date('2026-10-14T16:00:00Z');
const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>NVDA raises guidance</title><link>https://news.example/nvda-guide</link><pubDate>Tue, 14 Oct 2026 13:00:00 GMT</pubDate><description>Data center demand.</description></item>
</channel></rss>`;
const EDGAR = {
  filings: {
    recent: {
      form: ['8-K', '10-Q', '4', '4'],
      filingDate: ['2026-10-10', '2026-09-01', '2026-10-12', '2026-08-01'],
      accessionNumber: ['0001045810-26-000001', '0001045810-26-000002', '0001045810-26-000003', '0001045810-26-000004'],
      primaryDocument: ['a.htm', 'b.htm', 'c.xml', 'd.xml'],
      primaryDocDescription: ['Results', 'Quarterly', 'Statement', 'Old']
    }
  }
};

function fixtures(last = 180) {
  return {
    quotes: [{ symbol: 'NVDA', regularMarketPrice: last, chartPreviousClose: 178 }],
    robinhood: { results: [{ symbol: 'NVDA', last_trade_price: '181.25', previous_close: '178' }] },
    rss: { NVDA: RSS },
    earnings: [
      { symbol: 'NVDA', date: '2026-10-20', timing: '盘前' },
      { symbol: 'NVDA', date: '2026-12-01', timing: '盘后' },
      { symbol: 'AAPL', date: '2026-10-16', timing: '盘前' }
    ],
    tickers: { 0: { cik_str: 1045810, ticker: 'NVDA' } },
    submissions: { NVDA: EDGAR }
  };
}

test('public quote parsers stay unauthenticated and numeric', () => {
  const request = robinhoodQuoteRequest(['nvda', 'MU']);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers.authorization, undefined);
  assert.match(request.url, /symbols=NVDA%2CMU|symbols=NVDA,MU/);
  const yahoo = yahooQuoteFromChart('NVDA', { chart: { result: [{ meta: { regularMarketPrice: 180, chartPreviousClose: 178 } }] } });
  assert.equal(yahoo.source, 'yahoo');
  assert.equal(yahoo.last, 180);
  assert.ok(Math.abs(yahoo.changePct - (2 / 178) * 100) < 1e-9);
});

test('EDGAR keeps recent Form 4 and 8-K, and RSS keeps the headline link', () => {
  const filings = filingsFromSubmission('NVDA', '0001045810', EDGAR, { from: '2026-10-14', lookbackStart: '2026-10-01' });
  assert.deepEqual(filings.map((row) => row.kind), ['8-k', 'form4']);
  assert.match(filings[0].url, /\/1045810\/000104581026000001\/a\.htm$/);
  const headlines = headlinesFromRss(RSS, 'NVDA');
  assert.equal(headlines[0].id, 'https://news.example/nvda-guide');
  assert.deepEqual(headlines[0].symbols, ['NVDA']);
});

test('a quiet scan dedupes ledger fingerprints and does not wake on quote ticks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forum-agg-'));
  const ledgerDir = join(root, 'ledger');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(ledgerDir, { recursive: true });
  const watchlist = { symbols: ['NVDA'], keywords: ['guidance'] };
  const xNews = { posts: [
    { id: 'sports', text: 'hello world' },
    { id: 'other', text: '$AMD only' },
    { id: 'guide', author: 'desk', text: 'export guidance stays intact' }
  ] };
  const first = await refreshForumAggregate({
    root, ledgerDir, watchlist, xNews, now: NOW, offline: true, fixtures: fixtures()
  });
  assert.equal(first.silent, false);
  assert.ok(first.aggregate.newFingerprints.length >= 1);
  assert.equal(new Set(first.aggregate.newFingerprints).size, first.aggregate.newFingerprints.length);
  assert.equal(first.aggregate.queries.cashtags[0], '$NVDA');
  assert.equal(first.checklist.items.some((row) => row.eventKind === 'earnings' && row.date === '2026-10-20'), true);
  assert.equal(first.checklist.items.some((row) => row.date === '2026-12-01' || row.symbol === 'AAPL'), false);
  assert.equal(first.checklist.items.filter((row) => row.eventKind === '8-k' || row.eventKind === 'form4').length, 2);
  assert.equal(first.aggregate.quotes[0].last, 180);
  assert.equal(first.aggregate.quotes[0].robinhoodLast, 181.25);
  assert.equal(first.aggregate.newItems.some((row) => row.text.includes('hello world') || row.text.includes('$AMD')), false);
  const guide = newsItems(xNews).find((row) => row.id === 'guide');
  assert.match(first.aggregate.checklist, /us-forum-event-checklist\.json$/);
  const checklist = JSON.parse(await readFile(first.aggregate.checklist, 'utf8'));
  assert.equal(checklist.liveTrading, false);
  assert.equal(checklist.window.days, 14);
  await writeFile(join(ledgerDir, 'overheard-2026-10-14.md'), `# Overheard 2026-10-14 PT\n\n## A\n- note <!-- fp:${first.aggregate.newFingerprints.join(' -->\n- note <!-- fp:')} -->\n`, 'utf8');
  assert.ok(fingerprintsInText(await readFile(join(ledgerDir, 'overheard-2026-10-14.md'), 'utf8')).includes(guide.fingerprint));
  const second = await refreshForumAggregate({
    root, ledgerDir, watchlist, xNews, now: NOW, offline: true, fixtures: fixtures(181)
  });
  assert.equal(second.silent, true);
  assert.equal(second.aggregate.no_change, true);
  assert.equal(second.aggregate.duplicateCount > 0, true);
  assert.equal(second.aggregate.quotes[0].last, 181);
  await rm(root, { recursive: true, force: true });
});

test('aggregate sources do not read broker or X credentials', async () => {
  const src = await readFile(new URL('../src/bot/forum-aggregate.js', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../scripts/forum-aggregate.js', import.meta.url), 'utf8');
  assert.equal(/authorization|bearer|api[_-]?key|process\.env|secret/i.test(`${src}\n${cli}`), false);
});
