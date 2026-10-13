import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'kawaii-wheel-'));
process.env.KAWAII_DATA_DIR = join(root, 'data');

const { postWheel, readWheel, wheelPath } = await import('../src/options/wheel-ledger.js');

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('paper wheel ledger round-trips without a broker order', async () => {
  const opened = await postWheel({
    action: 'open',
    side: 'put',
    symbol: 'acm',
    strike: 50,
    premium: 1.25,
    expiration: '2026-11-12',
    dte: 30,
    delta: 0.24,
    spot: 55,
    asOf: '2026-10-13T15:00:00.000Z'
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.liveTrading, false);
  assert.equal(opened.orderId, undefined);
  assert.equal(opened.ledger.reservedCash, 5000);
  assert.equal(opened.quoteStatus, 'delayed-reference');
  assert.match(wheelPath(), /paper\/wheel\.json$/);

  const assigned = await postWheel({
    action: 'settle',
    symbol: 'ACM',
    spot: 40,
    asOf: '2026-11-12T21:00:00.000Z'
  });
  assert.equal(assigned.ledger.positions.ACM.shares, 100);
  assert.equal(assigned.ledger.positions.ACM.costBasis, 48.75);
  assert.equal(assigned.ledger.liveTrading, false);

  const viewed = await readWheel({
    candidates: [{ symbol: 'ACM', strike: 45, premium: 1, dte: 21, yield: 1 / 45, annualizedYield: 0.2, breakeven: 44 }]
  });
  assert.equal(viewed.candidates[0].breakeven, 44);
  assert.equal(viewed.ledger.positions.ACM.phase, 'long-stock');

  const reset = await postWheel({ action: 'reset' });
  assert.equal(reset.ledger.cash, 100000);
  assert.deepEqual(reset.ledger.positions, {});
  assert.equal(reset.liveTrading, false);

  const unknown = await postWheel({ action: 'send-order', symbol: 'ACM' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.liveTrading, false);
});
