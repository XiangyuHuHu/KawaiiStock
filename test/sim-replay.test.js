import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRecDate, sessionDaysBetween } from '../src/sim.js';

test('weekend rec feeds Monday open; newest in window wins', () => {
  const recs = ['2026-09-23', '2026-09-25', '2026-09-27', '2026-09-28'];
  assert.equal(pickRecDate(recs, '2026-09-28'), '2026-09-27');
  assert.equal(pickRecDate(recs, '2026-09-29'), '2026-09-28');
});

test('missing previous-session rec means HOLD, never an older rec', () => {
  assert.equal(pickRecDate(['2026-09-23'], '2026-09-25'), null);
  assert.equal(pickRecDate(['2026-09-25'], '2026-09-25'), null);
});

test('session days skip weekends', () => {
  assert.deepEqual(sessionDaysBetween('2026-09-24', '2026-09-29'), ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29']);
});
