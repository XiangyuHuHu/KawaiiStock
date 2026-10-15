import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAgenticBrief } from '../src/agentic-brief.js';

const day = '2026-09-21';

function pack(extra = {}) {
  return composeAgenticBrief({
    date: day,
    now: new Date('2026-09-21T14:00:00Z'),
    watch: {
      ok: true,
      date: day,
      regime: 'risk-on',
      boards: {
        confluence: [{
          symbol: 'ASX',
          stage: 'base-n-break',
          stageLabel: "Base 'n Break",
          score: 84,
          allowNewLong: true,
          confirmation: { confirmed: true },
          regime: 'risk-on',
          changePct: 3,
          last: 43
        }]
      },
      universeSnapshot: { rows: [{ symbol: 'TOST', stage: 'reversal-extension', stageLabel: 'Reversal Extension' }] },
      featured: { up: [], down: [] }
    },
    recs: {
      date: day,
      accounts: [{
        id: 'agentic',
        priorities: [{ symbol: 'ASX', action: 'BUY', title: 'Cycle 入场' }],
        recommendations: [],
        opportunities: [{ symbol: 'ASX', action: 'BUY' }]
      }]
    },
    holdings: { asOf: day, cash: 2600, positions: [{ symbol: 'TOST', qty: 7, last: 29.7 }] },
    meiBySymbol: { ASX: { direction: 'down' }, TOST: { direction: 'up' } },
    qiBySymbol: { ASX: { direction: 'up' }, TOST: { direction: 'neutral' } },
    ...extra
  });
}

test('oracle alone never opens a new Agentic buy', () => {
  const out = composeAgenticBrief({
    date: day,
    watch: { ok: true, date: day, regime: 'risk-on', boards: {}, featured: { up: [], down: [] }, universeSnapshot: { rows: [] } },
    recs: { date: day, accounts: [{ id: 'agentic', priorities: [], recommendations: [], opportunities: [] }] },
    holdings: { asOf: day, positions: [] },
    meiBySymbol: { XYZ: { direction: 'up' } },
    qiBySymbol: { XYZ: { direction: 'up' } }
  });
  assert.equal(out.liveTrading, false);
  assert.equal(out.actions.consider.length, 0);
  assert.match(out.headline, /先别开新仓|现仓|空/);
});

test('confirmed watch + daily BUY can consider, even if 梅花偏跌', () => {
  const out = pack();
  assert.equal(out.actions.consider[0]?.symbol, 'ASX');
  assert.equal(out.actions.consider[0]?.oracle, 'split');
  assert.equal(out.liveTrading, false);
  assert.equal(out.actions.hold[0]?.symbol, 'TOST');
  assert.equal(out.actions.hold[0]?.action, 'HOLD');
});

test('missing daily recs blocks new opens and keeps existing names', () => {
  const out = pack({ recs: null });
  assert.equal(out.actions.consider.length, 0);
  assert.equal(out.sources.recs.missing, true);
  assert.ok(out.actions.watch.some((row) => row.symbol === 'ASX'));
  assert.equal(out.actions.hold[0].symbol, 'TOST');
});

test('wedge-drop on a fresh holding is EXIT, stale holdings are REVIEW', () => {
  const fresh = pack({
    watch: {
      ok: true,
      date: day,
      regime: 'risk-on',
      boards: { avoid: [{ symbol: 'OKLO', stage: 'wedge-drop', stageLabel: 'Wedge Drop', score: 30 }] },
      featured: { up: [], down: [] },
      universeSnapshot: { rows: [] }
    },
    recs: { date: day, accounts: [{ id: 'agentic', priorities: [], recommendations: [{ symbol: 'OKLO', action: 'HOLD' }], opportunities: [] }] },
    holdings: { asOf: day, positions: [{ symbol: 'OKLO', qty: 20 }] }
  });
  assert.equal(fresh.actions.exit[0].symbol, 'OKLO');
  const stale = pack({
    holdings: { asOf: '2026-09-11', positions: [{ symbol: 'OKLO', qty: 20 }] }
  });
  assert.equal(stale.actions.exit.length, 0);
  assert.equal(stale.actions.review[0].symbol, 'OKLO');
  assert.equal(stale.stance, 'REVIEW');
});
