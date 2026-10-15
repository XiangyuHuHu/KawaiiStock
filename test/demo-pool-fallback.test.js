import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_DEMO_NOTE } from '../src/demo-pool.js';

const root = await mkdtemp(join(tmpdir(), 'kawaii-demo-'));
process.env.OBSIDIAN_LISTS = join(root, 'missing-lists');
process.env.KAWAII_LIST_DIR = join(root, 'missing-lists');
process.env.OBSIDIAN_HOLDINGS = join(root, 'holdings');
process.env.KAWAII_DATA_DIR = join(root, 'data');
process.env.OBSIDIAN_ORACLE = join(root, 'oracle');
process.env.KAWAII_REPORTS_DIR = join(root, 'reports');

await mkdir(process.env.KAWAII_DATA_DIR, { recursive: true });
await mkdir(process.env.OBSIDIAN_HOLDINGS, { recursive: true });
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

const { loadUniverse } = await import('../src/universe.js');
const { loadWatchlists } = await import('../src/screener/market-data.mjs');
const { ensureOracleWrite, buildOracleDesk, spxReadingFromCurrent } = await import('../src/oracle/qimen.js');
const { currentQimenChart } = await import('../src/oracle/qimen-current.js');
const { todayStamp } = await import('../src/paths.js');

test('missing watchlists fall back to the public demo pool with a note', async () => {
  const universe = await loadUniverse();
  assert.equal(universe.error, null);
  assert.equal(universe.fallback, 'public-demo');
  assert.equal(universe.note, PUBLIC_DEMO_NOTE);
  assert.deepEqual(universe.symbols.map((row) => row.symbol), ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'AVGO', 'JPM', 'V', 'MU']);

  const lists = await loadWatchlists();
  assert.equal(lists[0].id, 'public-demo');
  assert.equal(lists[0].note, PUBLIC_DEMO_NOTE);
  assert.deepEqual(lists[0].symbols, universe.symbols.map((row) => row.symbol));
});

test('today qimen write generates a chart; older empty days do not', async () => {
  const now = Date.parse('2026-10-13T16:00:00Z');
  const day = todayStamp(new Date(now));
  const loader = async () => ({ ok: true, source: 'test', bars: [], last: 1 });
  const old = await ensureOracleWrite({ date: '2020-01-02', now, loader });
  assert.equal(old.empty, true);
  assert.match(old.error, /不回填/);
  assert.equal(old.written, undefined);

  const reading = spxReadingFromCurrent(currentQimenChart(now), day);
  assert.equal(reading.date, day);
  assert.equal(reading.source, 'qimen-current');
  assert.ok(reading.chart.palaces.length > 0);
  assert.notEqual(reading.bias, '震荡偏多、先抑后扬');

  const pack = await ensureOracleWrite({ now, loader });
  assert.equal(pack.empty, undefined);
  assert.equal(pack.generatedChart, true);
  assert.equal(pack.date, day);
  assert.equal(pack.source, 'qimen-current');
  assert.equal(pack.liveTrading, false);
  assert.equal(pack.written.file, `${day}-spx`);
  assert.match(pack.note, /qimen-current/);

  const again = await buildOracleDesk({ date: day, now, loader });
  assert.notEqual(again.empty, true);
  assert.equal(again.source, 'qimen-current');
  assert.equal(again.cached, true);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});
