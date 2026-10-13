import test from 'node:test';
import assert from 'node:assert/strict';
import { validDate, watchFreshness, freshnessHtml, uniqueWatchRows, observationHtml, matchesWatchFilter } from '../public/watch-view.js';
import { versionRateText, universeStageHtml } from '../public/strategy-rate.js';
import { renderResearchPosterHtml } from '../src/posters.js';

const now = new Date('2026-09-15T14:00:00Z');
const row = { symbol: 'AAA', stage: 'wedge-pop', version: 'v2', priceDate: '2026-09-15', signalDate: '2026-09-15' };
const pack = (rows = [row]) => ({ date: '2026-09-15', generatedAt: now.toISOString(), featured: { up: rows } });

test('newly generated files never fill missing market or observation dates', () => {
  const data = pack([{ symbol: 'AAA' }]);
  delete data.date;
  const result = watchFreshness(data, 'us', now);
  assert.equal(result.observation, null);
  assert.equal(result.price.latest, null);
  assert.equal(result.signal.latest, null);
  assert.equal(result.stale, true);
  assert.match(freshnessHtml(data, 'us', now), /快照 未知/);
  assert.doesNotMatch(freshnessHtml(data, 'us', now), /HOLD/);
  for (const invalid of ['2026-02-30', 'invalid', '', null, undefined]) assert.equal(validDate(invalid), null);
});

test('one stale or undated row keeps warning even with a current latest date', () => {
  const data = pack([row, { ...row, symbol: 'BBB', priceDate: '2026-09-11' }, { ...row, symbol: 'CCC', signalDate: null }]);
  const result = watchFreshness(data, 'us', now);
  assert.equal(result.price.latest, '2026-09-15');
  assert.equal(result.price.earliest, '2026-09-11');
  assert.equal(result.signal.missing, 1);
  assert.equal(result.stale, true);
  assert.ok(result.reasons.some(reason => reason.includes('2026-09-11')));
});

test('current dated snapshots remain explicitly non-realtime; CN has no US signal requirement', () => {
  assert.equal(watchFreshness(pack(), 'us', now).stale, false);
  assert.match(freshnessHtml(pack(), 'us', now), /非实时/);
  assert.equal(watchFreshness(pack([{ ...row, signalDate: null }]), 'cn', now).stale, false);
  const boundary = new Date('2026-09-15T01:00:00Z');
  assert.equal(watchFreshness({}, 'us', boundary).target, '2026-09-14');
  assert.equal(watchFreshness({}, 'cn', boundary).target, '2026-09-15');
  assert.equal(watchFreshness({ ...pack(), date: '2026-09-11', requestedDate: '2026-09-11' }, 'us', now).stale, true);
  assert.equal(watchFreshness(pack([{ ...row, priceDate: '2026-09-16' }]), 'us', now).stale, true);
});

test('research chart cannot carry default-account trading suggestions or fake quote dates', () => {
  const model = { ok: true, symbol: 'AAA', last: 100, asOf: '2026-09-14', bars: [], levels: { r1: 105, r2: 110, s1: 95, s2: 90, sl: 85 }, plan: { action: 'TRIM', title: '碎片仓，优先清理' }, idea: { side: 'SELL', qty: 100 }, qty: 0 };
  const html = renderResearchPosterHtml(model, null);
  assert.doesNotMatch(html, /TRIM|SELL|碎片仓，优先清理|1970/);
  assert.match(html, /行情时间 未知/);
  assert.match(html, /日线截至 2026-09-14/);
  assert.match(html, /R1 \$105\.00/);
});

test('deduplicated cards preserve featured snapshot and every category without changing source', () => {
  const data = { ...pack([{ ...row, last: 12, side: 'up' }]), boards: { volume: [{ ...row, symbol: 'aaa', last: 99 }], rs: [{ ...row, symbol: 'BBB', allowNewLong: true }] } };
  const before = JSON.stringify(data);
  const rows = uniqueWatchRows(data);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'BBB');
  assert.equal(rows[1].last, 12);
  assert.deepEqual(rows[1].tags, ['偏多精选', '量能扩张']);
  assert.equal(JSON.stringify(data), before);
});

test('daily observation filters reuse saved cycle evidence without inventing a new score', () => {
  const swing = { stage: 'ema-crossback', watch: true, rs20: 8, volumeRatio: 1.6 };
  assert.equal(matchesWatchFilter(swing, 'early-swing'), true);
  assert.equal(matchesWatchFilter(swing, 'momentum'), true);
  assert.equal(matchesWatchFilter(swing, 'volume-expansion'), true);
  assert.equal(matchesWatchFilter(swing, 'breakout'), false);
  assert.equal(matchesWatchFilter({ stage: 'wedge-drop', rs20: -8 }, 'breakdown'), true);
  assert.equal(matchesWatchFilter({ stage: 'base-n-break', rs20: null }, 'momentum'), false);
});

test('current version never borrows historical aggregate success rate', () => {
  const stats = { n: 15, hits: 9, rate: 60 };
  const score = { locked: { byStage: { 'wedge-pop': stats }, byVersion: { v1: { byStage: { 'wedge-pop': stats } } } } };
  assert.match(versionRateText(row, score), /本版命中率待结算/);
  assert.doesNotMatch(versionRateText(row, score), /60/);
  assert.match(versionRateText({ ...row, version: 'v1' }, score), /9\/15/);
  assert.match(versionRateText({ ...row, version: null }, score), /版本未知/);
});

test('sample details explain missing next-day data and exclusions, snapshot detail retains original date', () => {
  const html = universeStageHtml({ universe: { samples: [
    { ...row, callDate: '2026-09-11', settleDate: '2026-09-14', status: 'pending', reason: 'missing-next-session-bar' },
    { symbol: '<unknown>', stage: 'unknown', status: 'excluded', reason: 'unknown-stage' }
  ] } });
  assert.match(html, /缺下一交易日日线/);
  assert.match(html, /结算 2026-09-14/);
  assert.match(html, /未知形态，已排除/);
  assert.match(html, /&lt;unknown&gt;/);
  const snapshot = observationHtml({ date: '2026-09-11', row: { ...row, score: 76 } });
  assert.match(snapshot, /观察日 2026-09-11/);
  assert.match(snapshot, /76 分/);
  assert.equal(observationHtml(null), '');
});
