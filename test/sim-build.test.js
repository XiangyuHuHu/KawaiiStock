import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSessionStamp, sizeBuild, buildCard, phaseOf } from '../src/sim-build.js';
import { applyRec } from '../src/sim.js';

const book = {
  id: 'main',
  cash: 90000,
  positions: [{ symbol: 'MSFT', qty: 5, last: 500, avgCost: 480, marketValue: 2500 }]
};

test('next session skips the weekend', () => {
  assert.equal(nextSessionStamp('2026-09-18'), '2026-09-21');
  assert.equal(nextSessionStamp('2026-09-21'), '2026-09-22');
});

test('BUY without share count gets one tranche and stays under the target', () => {
  const sized = sizeBuild(book, [
    { symbol: 'GRAL', action: 'BUY', last: 80 },
    { symbol: 'MSFT', action: 'HOLD', last: 500 }
  ], 'main');
  const gral = sized.find((row) => row.symbol === 'GRAL');
  const msft = sized.find((row) => row.symbol === 'MSFT');
  assert.ok(gral.tradeQty > 0);
  assert.equal(gral.build.label, 'ADD');
  assert.equal(gral.build.fromPct, 0);
  assert.ok(gral.build.toPct <= 2.5 + 0.05);
  assert.equal(gral.tradeQty * 80 <= 92500 * 0.025 + 1, true);
  assert.equal(msft.tradeQty, undefined);
  assert.equal(msft.build.label, 'HOLD');
  assert.equal(book.cash, 90000);
});

test('explicit order quantity is not resized', () => {
  const sized = sizeBuild(book, [{ symbol: 'NVDA', action: 'BUY', tradeQty: 2, last: 200 }], 'main');
  assert.equal(sized[0].tradeQty, 2);
  assert.equal(sized[0].build.explicit, true);
});

test('missing file and HOLD do not create a pending buy', () => {
  const card = buildCard(book, sizeBuild(book, [{ symbol: 'QQQ', action: 'HOLD', last: 400 }], 'main'), 'main', {
    signalDate: '2026-09-21',
    executeDate: '2026-09-22',
    settled: false
  });
  assert.equal(card.pending.length, 0);
  assert.equal(phaseOf(0.975, 'main'), 'RAMP_UP');
});

test('applyRec still refuses a buy that was not sized', () => {
  const empty = { cash: 1000, positions: [] };
  const quotes = { TEST: { ok: true, bar: { date: '2026-09-10', open: 100 } } };
  const result = applyRec(empty, {
    symbol: 'TEST', action: 'BUY', tradeQty: null, generatedAt: '2026-09-09T21:00:00Z'
  }, quotes, 'test');
  assert.equal(result.fill, null);
  assert.equal(empty.cash, 1000);
});
