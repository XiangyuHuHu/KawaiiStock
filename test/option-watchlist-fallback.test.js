import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'kawaii-pool-'));
const lists = join(root, 'lists');
process.env.OBSIDIAN_LISTS = lists;
process.env.OBSIDIAN_HOLDINGS = join(root, 'holdings');
process.env.KAWAII_DATA_DIR = join(root, 'data');
await mkdir(lists, { recursive: true });
await mkdir(process.env.OBSIDIAN_HOLDINGS, { recursive: true });
await mkdir(process.env.KAWAII_DATA_DIR, { recursive: true });

const symbols = Array.from({ length: 20 }, (_, i) => {
  const hi = String.fromCharCode(65 + Math.floor(i / 26));
  const lo = String.fromCharCode(65 + (i % 26));
  return `A${hi}${lo}`;
});
await writeFile(join(lists, '01 严选.md'), `---\ntitle: 严选\n---\n${symbols.map((symbol) => `| **${symbol}** |`).join('\n')}\n`);
await writeFile(join(process.env.KAWAII_DATA_DIR, 'accounts.json'), JSON.stringify({
  desks: [{
    id: 'grok',
    accounts: [
      { id: 'main', holdingsStem: 'main-holdings', source: 'manual' },
      { id: 'tactical', holdingsStem: 'tactical-holdings', source: 'manual' },
      { id: 'agentic', holdingsStem: 'agentic-holdings', source: 'manual' }
    ]
  }],
  focusTape: []
}));

const { optionUniverse, WATCHLIST_FALLBACK_N } = await import('../src/options/engine.js');

test('watchlist fallback stops once a research holding exists', async () => {
  const pool = await optionUniverse({ full: true });
  assert.equal(pool.poolSource, 'watchlist-fallback');
  assert.match(pool.poolNote, /观察清单前 16 只/);
  assert.doesNotMatch(pool.poolNote, /public-demo/);
  assert.equal(pool.length, WATCHLIST_FALLBACK_N);
  assert.deepEqual(pool.map((row) => row.symbol), symbols.slice(0, WATCHLIST_FALLBACK_N));
  assert.equal(pool.every((row) => row.from === 'watchlist-fallback'), true);

  await writeFile(join(process.env.OBSIDIAN_HOLDINGS, 'tactical-holdings.json'), JSON.stringify({
    positions: [{ symbol: 'TSLA', name: 'Tesla' }]
  }));
  const held = await optionUniverse({ full: true });
  assert.equal(held.poolSource, 'holdings-tape');
  assert.equal(held.poolNote, null);
  assert.deepEqual(held.map((row) => row.symbol), ['TSLA']);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});
