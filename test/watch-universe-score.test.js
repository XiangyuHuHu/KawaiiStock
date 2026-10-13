import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { universeSnapshot, summarizeUniverse } from '../src/strategy/watch-universe-score.js';
import { STAGE_ORDER, stageStripHtml, universeStageHtml } from '../public/strategy-rate.js';

const date = '2026-09-11';
const closed = new Date('2026-09-14T21:00:00Z');
const rows = STAGE_ORDER.map((stage, index) => ({ symbol: `S${index}`, stage: stage.id, last: 100, priceDate: date }));
const snapshot = () => universeSnapshot({ date, generatedAt: '2026-09-11T21:00:00Z', strategy: { version: 'v2' }, rows });
const histories = () => Object.fromEntries(rows.map((row, index) => [row.symbol, { ok: true, bars: [{ date: '2026-09-14', close: 100 + (index % 3 - 1) * 10 }] }]));

test('full pool includes all six stages independently of the top-six candidates', () => {
  const full = summarizeUniverse([snapshot()], histories(), { now: closed, legacyDates: ['2026-09-10', date] });
  assert.equal(full.all.n, 6);
  assert.equal(full.all.up, 2);
  assert.equal(full.all.down, 2);
  assert.equal(full.all.flat, 2);
  assert.equal(full.all.avgRet, 0);
  for (const stage of STAGE_ORDER) assert.equal(full.byStage[stage.id].n, 1);
  assert.deepEqual(full.uncollectedDates, ['2026-09-10']);
  assert.equal(full.liveTrading, false);
  assert.equal(full.locked, undefined, 'full outcomes do not impersonate featured directional hit rates');
});

test('next-day bars cannot settle before close, including a weekend boundary', () => {
  const full = summarizeUniverse([snapshot()], histories(), { now: new Date('2026-09-14T19:00:00Z') });
  assert.equal(full.all.n, 0);
  assert.equal(full.all.awaitingClose, 6);
  assert.equal(full.samples[0].settleDate, '2026-09-14');
});

test('missing next-session bar stays pending; later days cannot substitute', () => {
  const hists = histories();
  hists.S0.bars = [{ date: '2026-09-15', close: 110 }];
  const full = summarizeUniverse([snapshot()], hists, { now: new Date('2026-09-16T21:00:00Z') });
  assert.equal(full.all.n, 5);
  assert.equal(full.all.missingBar, 1);
  assert.equal(full.samples[0].retPct, null);
});

test('deduplication is per observation day and symbol, not per card or lifetime', () => {
  const first = universeSnapshot({ date, rows: [rows[0], { ...rows[0], symbol: 's0', stage: 'wedge-drop' }] });
  assert.equal(first.rows.length, 1);
  const next = { ...first, date: '2026-09-14', rows: first.rows.map(row => ({ ...row, priceDate: '2026-09-14' })) };
  const full = summarizeUniverse([first, first, next], histories(), { now: closed });
  assert.equal(full.all.observed, 2);
  assert.equal(full.all.n, 1);
  assert.equal(full.all.pending, 1);
});

test('unknown stages, bad prices and stale observation prices are excluded, never fabricated', () => {
  const pack = snapshot();
  pack.rows[0].stage = 'unknown';
  pack.rows[1].last = null;
  pack.rows[2].priceDate = '2026-09-10';
  const full = summarizeUniverse([pack], histories(), { now: closed });
  assert.equal(full.all.excluded, 3);
  assert.equal(full.all.n, 3);
  assert.equal(full.byStage['ema-crossback'].excluded, 1);
});

test('UI distinguishes uncollected, not selected, no occurrence, pending and settled outcomes', () => {
  assert.match(universeStageHtml(null), /未采集完整股票池/);
  const featured = { ok: true, locked: { byStage: {} }, pending: [{ stage: 'ema-crossback' }] };
  assert.match(stageStripHtml(featured), /未入选已记录的精选名单/);
  assert.match(stageStripHtml(featured), /1 个待结算/);
  const full = summarizeUniverse([{ ...snapshot(), rows: [rows[0]] }], histories(), { now: closed });
  assert.match(universeStageHtml({ universe: full }), /未观察到该形态/);
  assert.match(universeStageHtml({ universe: full }), /下跌 100%/);
});

test('repeated scans preserve the first full snapshot and never modify legacy featured snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-universe-test-'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { OBSIDIAN_WATCH } from './src/paths.js';
    import { universeSnapshot, saveUniverseSnapshot, loadUniverseSnapshots } from './src/strategy/watch-universe-score.js';
    await mkdir(join(OBSIDIAN_WATCH, 'snapshots'), {recursive: true});
    const legacyPath = join(OBSIDIAN_WATCH, 'snapshots', '2026-09-11.json');
    const legacy = JSON.stringify({date:'2026-09-11', featured:{up:[],down:[]}});
    await writeFile(legacyPath, legacy);
    assert.deepEqual(await loadUniverseSnapshots(), []);
    const snap = universeSnapshot({ date:'2026-09-14', rows:[{symbol:'TEST',stage:'base-n-break',last:100,priceDate:'2026-09-14'}] });
    await saveUniverseSnapshot(snap);
    snap.rows[0].last = 999;
    await saveUniverseSnapshot(snap);
    const loaded = await loadUniverseSnapshots();
    assert.equal(loaded.length,1);
    assert.equal(loaded[0].rows[0].last,100);
    assert.equal(await readFile(legacyPath,'utf8'),legacy);
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, OBSIDIAN_WATCH: dir } });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
