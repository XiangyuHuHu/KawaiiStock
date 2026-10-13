import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAutoMode, resolveMode } from '../src/risk/mode.js';
import { assertOrder } from '../src/risk/gateway.js';
import { holdingsFreshness } from '../src/holdings.js';
import { PAPER_VIEW_NOTE, asPaperView } from '../src/recommend.js';
import { parseOrderArgs } from '../scripts/order.js';
import { buildSymbolOracle } from '../src/oracle/symbols.js';

test('missing holdings file is not configured; a stale file stays reduce-only', () => {
  const missing = deriveAutoMode({ book: 'live', holdingsConfigured: false, holdingsFresh: false, nav: null }, {});
  assert.equal(missing.mode, 'NOT_CONFIGURED');
  assert.match(missing.reason, /未配置/);
  const view = resolveMode({ book: 'live', holdingsConfigured: false, holdingsFresh: false }, {}, { mode: 'NORMAL' });
  assert.equal(view.mode, 'NOT_CONFIGURED');
  assert.match(view.reason, /未配置/);

  const stale = deriveAutoMode({ book: 'live', holdingsConfigured: true, holdingsFresh: false, nav: 5000 }, {});
  assert.equal(stale.mode, 'REDUCE_ONLY');
  assert.match(stale.reason, /不是今日实时/);
});

test('a live open without a holdings file is not-configured rather than stale', () => {
  const denied = assertOrder(
    { symbol: 'AAPL', side: 'buy', qty: 1, limitPrice: 10, book: 'live', accountId: 'agentic' },
    { book: 'live', nav: 5000, holdingsConfigured: false, holdingsFresh: false, positions: [] },
    { phase: 1, caps: {} },
    { now: Date.now(), book: 'live', accountId: 'agentic' }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'not-configured');
  assert.equal(holdingsFreshness({ configured: false, missing: true }).configured, false);
  assert.equal(holdingsFreshness({ missing: true, positions: [] }).configured, true);
});

test('paper candidates are a labeled view and may overlap opportunities', () => {
  const opportunities = [{ symbol: 'AAA', action: 'BUY' }];
  const paper = asPaperView(opportunities, [
    { symbol: 'AAA', action: 'BUY', failPrice: 1 },
    { symbol: 'BBB', action: 'WATCH', failPrice: 2 }
  ]);
  assert.equal(paper[0].view, 'paper');
  assert.equal(paper[0].viewLabel, '纸上实验候选');
  assert.equal(paper[0].overlapsOpportunities, true);
  assert.equal(paper[1].overlapsOpportunities, false);
  assert.match(PAPER_VIEW_NOTE, /独立视图/);
  assert.match(PAPER_VIEW_NOTE, /不是第二份推荐/);
});

test('order --book defaults to paper', () => {
  assert.equal(parseOrderArgs(['node', 'scripts/order.js', '--symbol', 'TEM', '--qty', '4']).book, 'paper');
  assert.equal(parseOrderArgs(['node', 'scripts/order.js', '--book', 'live', '--symbol', 'TEM']).book, 'live');
  assert.equal(parseOrderArgs(['node', 'scripts/order.js', '--book', 'paper-0c', '--symbol', 'TEM']).book, 'paper-0c');
});

test('meihua scope explains a watchlist fallback pool', async () => {
  const rows = [{ symbol: 'AAPL', name: 'Apple', from: 'watchlist-fallback' }];
  rows.poolNote = '研究持仓和关注带为空，已回退到观察清单前 1 只。';
  rows.poolSource = 'watchlist-fallback';
  const pack = await buildSymbolOracle({
    date: '2026-10-13',
    now: Date.parse('2026-10-13T16:00:00Z'),
    universeLoader: async () => rows
  });
  assert.equal(pack.rows.length, 1);
  assert.match(pack.scope, /回退/);
  assert.equal(pack.poolSource, 'watchlist-fallback');
  assert.equal(pack.liveTrading, false);
});
