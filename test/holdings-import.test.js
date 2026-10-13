import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'kawaii-import-'));
process.env.OBSIDIAN_HOLDINGS = join(root, 'holdings');
process.env.KAWAII_DATA_DIR = join(root, 'data');
process.env.OBSIDIAN_LISTS = join(root, 'lists');
process.env.OBSIDIAN_VAULT = join(root, 'vault');
await mkdir(process.env.OBSIDIAN_HOLDINGS, { recursive: true });
await mkdir(process.env.KAWAII_DATA_DIR, { recursive: true });
await writeFile(join(process.env.KAWAII_DATA_DIR, 'accounts.json'), JSON.stringify({
  desks: [{
    id: 'grok',
    writable: true,
    accounts: [
      { id: 'main', label: '主账户', holdingsStem: 'main-holdings', source: 'manual' },
      { id: 'agentic', label: '实验账户', holdingsStem: 'agentic-holdings', source: 'manual' }
    ]
  }]
}));

const { importHoldings, loadHoldings, canImportHoldings } = await import('../src/holdings.js');
const now = new Date('2026-10-13T16:00:00Z');
const agentic = { id: 'agentic', label: '实验账户', holdingsStem: 'agentic-holdings', source: 'manual' };
const main = { id: 'main', label: '主账户', holdingsStem: 'main-holdings', source: 'manual' };

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('agentic can import a Robinhood positions export and shows its age', async () => {
  assert.equal(canImportHoldings(agentic), true);
  assert.equal(canImportHoldings(main), false);
  await assert.rejects(() => importHoldings(main, { results: [{ symbol: 'HAE', quantity: '1' }] }, now), /不会下单/);
  const saved = await importHoldings(agentic, {
    updated_at: '2026-09-01T15:00:00Z',
    results: [
      { symbol: 'HAE', quantity: '12.0000', average_buy_price: '80.5', instrument: { simple_name: 'Haemonetics' } },
      { quantity: '3', average_buy_price: '1' }
    ]
  }, now);
  assert.equal(saved.liveTrading, undefined);
  assert.equal(saved.positions[0].symbol, 'HAE');
  assert.equal(saved.positions[0].qty, 12);
  assert.equal(saved.positions.length, 1);
  assert.deepEqual(saved.openOrders, []);
  assert.equal(saved.stale, true);
  assert.ok(saved.staleAgeDays > 30);
  assert.match(saved.staleLabel, /已过/);
  assert.match(saved.note, /不下单/);
  const loaded = await loadHoldings(agentic);
  assert.equal(loaded.positions[0].symbol, 'HAE');
  assert.equal(loaded.configured, true);
  assert.equal(loaded.stale, true);
  assert.match(loaded.staleLabel, /已过/);
});

test('an export without a date is unknown, and a same-day export is not aged', async () => {
  const unknown = await importHoldings(agentic, {
    results: [{ symbol: 'AAPL', quantity: '2', average_buy_price: '200' }]
  }, now);
  assert.equal(unknown.staleAgeDays, null);
  assert.match(unknown.staleLabel, /未知/);
  assert.equal(unknown.stale, true);
  const fresh = await importHoldings(agentic, {
    updated_at: '2026-10-13T14:00:00Z',
    results: [{ symbol: 'MSFT', quantity: '1' }]
  }, now);
  assert.equal(fresh.staleAgeDays, 0);
  assert.equal(fresh.stale, false);
  assert.match(fresh.staleLabel, /2026-10-13/);
  assert.doesNotMatch(fresh.note, /下单接口|已发送/);
});
