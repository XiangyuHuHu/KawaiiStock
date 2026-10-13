import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  annualizedYield,
  emptyWheelLedger,
  markWheel,
  openCashSecuredPut,
  openCoveredCall,
  rollWheel,
  selectCashSecuredPut,
  selectCoveredCall,
  settleWheel,
  wheelCandidatesFromContexts
} from '../src/options/wheel.js';
import { renderOptionsMarkdown } from '../src/options/engine.js';

const put = (extra) => ({
  strike: 94,
  bid: 1.5,
  ask: 1.7,
  volume: 40,
  openInterest: 80,
  delta: 0.25,
  expiration: '2026-11-12',
  ...extra
});

test('cash-secured put prefers a 0.20–0.30 delta inside 7–45 DTE', () => {
  const picked = selectCashSecuredPut({
    spot: 100,
    dte: 30,
    expiration: '2026-11-12',
    support: 90,
    source: 'yahoo',
    puts: [
      put({ strike: 90, bid: 3, ask: 3.2, delta: 0.5, openInterest: 500 }),
      put({ strike: 95, bid: 1, ask: 1.1, delta: 0.25, dte: 3, expiration: '2026-10-16' }),
      put({ strike: 94, bid: 1.5, ask: 1.6, delta: 0.25 }),
      put({ strike: 80, bid: 0.4, ask: 0.5, delta: 0.08, openInterest: 10 })
    ]
  });
  assert.equal(picked.strike, 94);
  assert.equal(picked.premium, 1.5);
  assert.equal(picked.dte, 30);
  assert.equal(picked.cashReserved, 9400);
  assert.equal(picked.breakeven, 92.5);
  assert.equal(picked.yield, 1.5 / 94);
  assert.equal(picked.annualizedYield, annualizedYield(1.5, 94, 30));
  assert.equal(picked.quoteStatus, 'delayed-reference');
  assert.equal(annualizedYield(2, 100, 30), (2 / 100) * (365 / 30));
});

test('a put below support still qualifies when delta is unknown', () => {
  const picked = selectCashSecuredPut({
    spot: 100,
    dte: 21,
    support: 92,
    puts: [put({ strike: 91, bid: 0.8, ask: 0.9, delta: undefined, iv: undefined, dte: 21 })]
  });
  assert.equal(picked.strike, 91);
  assert.equal(picked.delta, null);
  assert.equal(picked.belowSupport, true);
  assert.equal(picked.breakeven, 90.2);
});

test('illiquid, short-dated, and deep delta puts are not candidates', () => {
  assert.equal(selectCashSecuredPut({
    spot: 100,
    dte: 30,
    puts: [put({ volume: 0, openInterest: 0 })]
  }), null);
  assert.equal(selectCashSecuredPut({
    spot: 100,
    dte: 3,
    puts: [put({ dte: 3 })]
  }), null);
  assert.equal(selectCashSecuredPut({
    spot: 100,
    dte: 30,
    puts: [put({ delta: 0.55, strike: 99 })]
  }), null);
});

test('wheel scan lists candidates with strike, premium, DTE, yield, and breakeven', () => {
  const rows = wheelCandidatesFromContexts([
    {
      symbol: 'zzz',
      last: 100,
      daily: [{ low: 90 }, { low: 92 }],
      chain: { dte: 14, expiration: '2026-10-27', source: 'yahoo', puts: [put({ bid: 1, ask: 1.2, delta: 0.22 })] }
    },
    {
      symbol: 'aaa',
      last: 50,
      chain: { dte: 20, expiration: '2026-11-02', source: 'nasdaq', puts: [put({ strike: 45, bid: 2, ask: 2.2, delta: 0.28, expiration: '2026-11-02' })] }
    }
  ]);
  assert.deepEqual(rows.map((row) => row.symbol), ['AAA', 'ZZZ']);
  assert.equal(rows[0].premium, 2);
  assert.equal(rows[0].dte, 20);
  assert.equal(rows[0].breakeven, 43);
  assert.ok(rows[0].yield > rows[1].yield);
});

test('assignment, covered call above cost, called away, and OTM roll', () => {
  const opened = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'acm',
    strike: 100,
    premium: 2,
    expiration: '2026-11-12',
    dte: 30,
    delta: 0.25,
    spot: 104,
    asOf: '2026-09-13T15:00:00.000Z'
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.ledger.liveTrading, false);
  assert.equal(opened.ledger.reservedCash, 10000);
  assert.equal(opened.ledger.cash, 100200);
  assert.equal(opened.ledger.positions.ACM.phase, 'short-put');
  assert.ok(Math.abs(opened.ledger.positions.ACM.annualizedYield - (200 / 10000) * (365 / 30)) < 1e-9);

  const tooClose = openCoveredCall(opened.ledger, {
    symbol: 'ACM',
    strike: 98,
    premium: 1,
    expiration: '2026-12-01'
  });
  assert.equal(tooClose.ok, false);

  const assigned = settleWheel(opened.ledger, { symbol: 'ACM', spot: 90, asOf: '2026-10-13T15:00:00.000Z' });
  const held = assigned.ledger.positions.ACM;
  assert.equal(held.phase, 'long-stock');
  assert.equal(held.shares, 100);
  assert.equal(held.assignments, 1);
  assert.equal(held.costBasis, 98);
  const atBasis = openCoveredCall(assigned.ledger, {
    symbol: 'ACM',
    strike: 98,
    premium: 1,
    expiration: '2026-12-01'
  });
  assert.equal(atBasis.ok, false);
  assert.match(atBasis.error, /高于成本/);
  assert.equal(assigned.ledger.reservedCash, 0);
  assert.equal(assigned.ledger.cash, 90200);
  assert.ok(Math.abs((assigned.ledger.equity - assigned.ledger.seed) - (assigned.ledger.realizedPnl + assigned.ledger.unrealizedPnl)) < 0.02);

  const call = selectCoveredCall({
    spot: 90,
    costBasis: held.costBasis,
    dte: 30,
    calls: [
      put({ type: 'call', strike: 97, bid: 4, ask: 4.2, delta: 0.25 }),
      put({ type: 'call', strike: 105, bid: 1.5, ask: 1.7, delta: 0.25, expiration: '2026-11-12' })
    ]
  });
  assert.equal(call.strike, 105);
  assert.ok(call.strike > held.costBasis);

  const sold = openCoveredCall(assigned.ledger, {
    symbol: 'ACM',
    strike: 105,
    premium: 1.5,
    expiration: '2026-11-12',
    dte: 30,
    delta: 0.25,
    spot: 90,
    asOf: '2026-10-14T15:00:00.000Z'
  });
  assert.equal(sold.ok, true);
  assert.equal(sold.ledger.positions.ACM.phase, 'covered-call');
  assert.equal(sold.ledger.positions.ACM.premiumIncome, 350);

  const called = settleWheel(sold.ledger, { symbol: 'ACM', spot: 110, asOf: '2026-11-12T21:00:00.000Z' });
  assert.equal(called.ledger.positions.ACM, undefined);
  assert.equal(called.ledger.realizedPnl, 850);
  assert.equal(called.ledger.cash, 100850);
  assert.equal(called.ledger.unrealizedPnl, 0);
  assert.equal(called.ledger.closedCycles.at(-1).event, 'called-away');
  assert.equal(called.ledger.closedCycles.at(-1).assignments, 1);

  const again = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'acm',
    strike: 100,
    premium: 2,
    expiration: '2026-11-12',
    spot: 104,
    asOf: '2026-09-13T15:00:00.000Z'
  });
  const rolled = rollWheel(again.ledger, {
    symbol: 'ACM',
    spot: 103,
    asOf: '2026-10-13T15:00:00.000Z',
    candidate: { side: 'put', strike: 95, premium: 1.2, expiration: '2026-11-20', dte: 21, delta: 0.22 }
  });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.ledger.realizedPnl, 200);
  assert.equal(rolled.ledger.positions.ACM.phase, 'short-put');
  assert.equal(rolled.ledger.positions.ACM.leg.strike, 95);
  assert.equal(rolled.ledger.positions.ACM.rolls, 1);
  assert.equal(rolled.ledger.closedCycles[0].event, 'put-otm');
  assert.equal(rolled.ledger.closedCycles[0].premiumIncome, 200);
});

test('a falling stock increases unrealized loss and max drawdown', () => {
  const opened = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'drop',
    strike: 100,
    premium: 2,
    expiration: '2026-11-12',
    spot: 100,
    asOf: '2026-10-01T15:00:00.000Z'
  });
  const fallen = markWheel(opened.ledger, { DROP: 70 }, '2026-10-13T15:00:00.000Z');
  assert.ok(fallen.positions.DROP.unrealizedPnl < 0);
  assert.ok(fallen.maxDrawdown > 0);
  assert.ok(fallen.maxDrawdownUsd > 0);
  assert.ok(Math.abs((fallen.equity - fallen.seed) - (fallen.realizedPnl + fallen.unrealizedPnl)) < 0.02);
  const assigned = settleWheel(fallen, { symbol: 'DROP', spot: 60, asOf: '2026-10-20T15:00:00.000Z' });
  assert.equal(assigned.ledger.positions.DROP.costBasis, 98);
  assert.ok(assigned.ledger.positions.DROP.unrealizedPnl < fallen.positions.DROP.unrealizedPnl);
  assert.ok(assigned.ledger.maxDrawdown > fallen.maxDrawdown);
});

test('same-day assignment keeps the put horizon in the annualized yield', () => {
  const opened = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'day',
    strike: 100,
    premium: 2,
    expiration: '2026-11-12',
    dte: 30,
    spot: 110,
    asOf: '2026-10-13T15:00:00.000Z'
  });
  const assigned = settleWheel(opened.ledger, { symbol: 'DAY', spot: 90, asOf: '2026-10-13T20:00:00.000Z' });
  const row = assigned.ledger.positions.DAY;
  assert.equal(row.phase, 'long-stock');
  assert.equal(row.leg, null);
  assert.ok(Math.abs(row.annualizedYield - (200 / 10000) * (365 / 30)) < 1e-6);
  assert.ok(row.annualizedYield < 1);
});

test('opening a put rejects when cash cannot secure the strike', () => {
  const denied = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'big',
    strike: 2000,
    premium: 10,
    expiration: '2026-11-12'
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /不够锁定/);
  assert.equal(denied.liveTrading, false);
});

test('an OTM covered call keeps the shares, the premium, and a lower cost basis', () => {
  let ledger = openCashSecuredPut(emptyWheelLedger(), {
    symbol: 'otm',
    strike: 100,
    premium: 2,
    expiration: '2026-11-12',
    asOf: '2026-10-01T15:00:00.000Z'
  }).ledger;
  ledger = settleWheel(ledger, { symbol: 'OTM', spot: 90, asOf: '2026-11-12T21:00:00.000Z' }).ledger;
  ledger = openCoveredCall(ledger, {
    symbol: 'OTM',
    strike: 110,
    premium: 1,
    expiration: '2026-12-18',
    spot: 96,
    asOf: '2026-11-13T15:00:00.000Z'
  }).ledger;
  const kept = settleWheel(ledger, { symbol: 'OTM', spot: 100, asOf: '2026-12-18T21:00:00.000Z' });
  assert.equal(kept.ledger.positions.OTM.phase, 'long-stock');
  assert.equal(kept.ledger.positions.OTM.shares, 100);
  assert.equal(kept.ledger.positions.OTM.costBasis, 97);
  assert.equal(kept.ledger.positions.OTM.premiumIncome, 300);
  assert.equal(kept.ledger.realizedPnl, 0);
});

test('the daily options note lists wheel candidates and stays paper-only', () => {
  const markdown = renderOptionsMarkdown({
    date: '2026-10-13',
    strategy: { id: 'cov', name: 'COV', summary: '研究' },
    note: '草稿',
    scanned: 1,
    vix: 'unknown',
    buys: [],
    tempting: [],
    ideas: [],
    wheelCandidates: [{ symbol: 'AAPL', strike: 100, premium: 2, dte: 30, yield: 0.02, annualizedYield: 0.2433, breakeven: 98 }]
  });
  assert.match(markdown, /AAPL/);
  assert.match(markdown, /98/);
  assert.match(markdown, /纸上轮证候选/);
  assert.match(markdown, /liveTrading: false/);
});

test('wheel code does not place broker orders', () => {
  for (const file of ['../src/options/wheel.js', '../src/options/wheel-ledger.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('placeEquityOrder'), false);
    assert.equal(source.includes('placeOptionOrder'), false);
    assert.equal(source.includes('checkOrder'), false);
    assert.equal(source.includes('robinhood'), false);
  }
});
