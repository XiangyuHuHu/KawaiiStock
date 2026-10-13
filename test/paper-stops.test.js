import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerStopHit, regularPaperSession } from '../src/paper/execution.js';
import { calendarWarning, isUsSessionDay } from '../src/paths.js';
import { stopReplayStart } from '../src/paper/desk.js';

test('a stop that moved later is never replayed against earlier bars', () => {
  const buy = { symbol: 'AXTI', instrument: 'equity', side: 'buy', date: '2026-09-03', stopPrice: 52.39 };
  const tp = { symbol: 'AXTI', instrument: 'equity', side: 'sell', date: '2026-09-30', stopPrice: 56.95 };
  const pos = { symbol: 'AXTI', instrument: 'equity', stopPrice: 56.95, entryStop: 56.95 };
  assert.equal(stopReplayStart(pos, [buy, tp], '2026-09-30'), '2026-09-30');
  assert.equal(stopReplayStart({ ...pos, stopPrice: 52.39 }, [buy], '2026-09-30'), '2026-09-03');
  assert.equal(stopReplayStart({ ...pos, stopPrice: 52.39, trailedAt: '2026-09-20T15:00:00Z' }, [buy], '2026-09-30'), '2026-09-30');
  assert.equal(stopReplayStart({ ...pos, stopCheckedThrough: '2026-09-29' }, [buy, tp], '2026-09-30'), '2026-09-29');
});

const bars = [
  { date: '2026-09-28', open: 105, low: 101, close: 104 },
  { date: '2026-09-29', open: 103, low: 99, close: 102 },
  { date: '2026-09-30', open: 95, low: 93, close: 96 }
];

test('broker stop fills on first touching bar at the stop', () => {
  const hit = brokerStopHit(bars, 100, '2026-09-27', '2026-09-30');
  assert.equal(hit.date, '2026-09-29');
  assert.equal(hit.reference, 100);
});

test('gap down below stop fills at the open, not the stop', () => {
  const hit = brokerStopHit(bars, 97, '2026-09-29', '2026-09-30');
  assert.equal(hit.date, '2026-09-30');
  assert.equal(hit.reference, 95);
});

test('bars on or before the stop-set day are ignored', () => {
  assert.equal(brokerStopHit(bars, 100, '2026-09-29', '2026-09-29'), null);
});

test('regular session excludes pre-market, after-hours and weekends', () => {
  assert.equal(regularPaperSession(Date.parse('2026-09-30T14:00:00Z')), true);
  assert.equal(regularPaperSession(Date.parse('2026-09-30T13:00:00Z')), false);
  assert.equal(regularPaperSession(Date.parse('2026-10-01T05:24:00Z')), false);
  assert.equal(regularPaperSession(Date.parse('2026-10-03T15:00:00Z')), false);
});

test('2027-2028 holidays are closed and the calendar warns before expiry', () => {
  for (const day of ['2027-01-01', '2027-03-26', '2027-07-05', '2027-12-24', '2028-04-14', '2028-12-25']) assert.equal(isUsSessionDay(day), false, day);
  assert.equal(isUsSessionDay('2027-12-31'), true);
  assert.equal(calendarWarning('2026-09-30'), null);
  assert.match(calendarWarning('2028-11-15'), /还剩/);
  assert.match(calendarWarning('2029-01-02'), /已过期/);
});
