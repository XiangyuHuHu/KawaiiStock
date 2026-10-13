import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExpirationChain } from '../src/options/market.js';
import { refreshDisplayedQuotes } from '../src/options/engine.js';

test('expiration loader follows the held date when the first response is a different week', async () => {
  const seen = [];
  const requested = Math.floor(Date.parse('2026-10-09T00:00:00Z') / 1000);
  const listed = Math.floor(Date.parse('2026-10-09T20:00:00Z') / 1000);
  const loader = async (symbol, unix) => {
    seen.push(unix ?? null);
    if (unix === listed) return { ok: true, calls: [{ type: 'call', expiration: '2026-10-09', strike: 205, bid: 1.2, ask: 1.4 }], puts: [] };
    return { ok: true, expirationDates: [listed], calls: [{ type: 'call', expiration: '2026-10-23', strike: 220, bid: 9, ask: 9.2 }], puts: [] };
  };
  const chain = await loadExpirationChain('ANET', '2026-10-09', { loader });
  assert.equal(chain.calls[0].expiration, '2026-10-09');
  assert.equal(chain.calls[0].bid, 1.2);
  assert.deepEqual(seen, [requested, listed]);
});

test('displayed quote refresh updates bid/ask and does not invent a timestamp', async () => {
  const pack = {
    ok: true,
    date: '2026-10-09',
    modelVersion: 'option-research-v3',
    scanId: 'scan',
    costAssumptions: { feePerContract: 0.03 },
    ideas: [{
      symbol: 'ANET',
      action: 'NO_TRADE',
      last: 100,
      contract: { expiration: '2026-10-23', legs: [{ type: 'call', expiration: '2026-10-23', strike: 220, bid: 1, ask: 1.1, quoteAt: null }] },
      sourceTimes: {}
    }]
  };
  const loader = async () => ({
    ok: true,
    last: 210,
    underlyingQuoteAt: Date.parse('2026-10-09T15:00:00Z'),
    source: 'yahoo',
    calls: [{ type: 'call', expiration: '2026-10-23', strike: 220, bid: 5.1, ask: 5.4, quoteAt: null, last: 5.2 }],
    puts: []
  });
  const next = await refreshDisplayedQuotes(pack, { loader });
  const leg = next.ideas[0].contract.legs[0];
  assert.equal(leg.bid, 5.1);
  assert.equal(leg.ask, 5.4);
  assert.equal(leg.quoteAt, null);
  assert.equal(next.ideas[0].last, 210);
  assert.ok(next.quotesRefreshedAt);
  assert.equal(pack.ideas[0].contract.legs[0].bid, 1);
});
