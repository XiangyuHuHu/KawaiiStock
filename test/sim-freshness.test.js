import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSimFreshness, sourceDate } from '../src/sim-freshness.js';
import { lastSessionStamp } from '../src/paths.js';

const date = '2026-09-14';
const old = '2026-09-11';
const ids = ['main', 'tactical', 'agentic'];
function fixture() {
  return {
    observationDate: date,
    recommendations: [{ date, format: 'json' }],
    actuals: [{ date }],
    holdings: ids.map((id) => ({ id, label: id, asOf: date })),
    history: [{ date, plans: Object.fromEntries(ids.map((id) => [id, { basis: 'daily-rec' }])), fills: [] }]
  };
}

test('explicit current HOLD/no fills can be current without claiming live trading', () => {
  const result = buildSimFreshness(fixture());
  assert.equal(result.stale, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.sources.settlement.date, date);
});

for (const key of ['recommendations', 'actuals', 'holdings', 'history']) {
  test(`one stale source (${key}) is enough to show the banner`, () => {
    const input = fixture();
    if (key === 'holdings') input.holdings[0].asOf = old;
    else input[key][0].date = old;
    const result = buildSimFreshness(input);
    assert.equal(result.stale, true);
    assert.ok(result.reasons.some((reason) => reason.includes(old) && reason.includes(date)));
  });
}

test('missing dates never default to observation day or updatedAt', () => {
  const result = buildSimFreshness({ observationDate: date, holdings: [{ id: 'main', label: '主账户', updatedAt: date }], history: [{ generatedAt: date, plans: { main: { basis: 'daily-rec' } } }] });
  assert.equal(result.stale, true);
  for (const source of Object.values(result.sources)) assert.equal(source.date, null);
  for (const invalid of [null, '', 'bad date', '2026-02-30', '2026-09-14garbage']) assert.equal(sourceDate(invalid), null);
});

test('legacy missing-file HOLD and partial settlement do not advance valid settlement date', () => {
  const input = fixture();
  input.history[0].date = old;
  input.history.push({ date, plans: { main: { basis: 'daily-rec' }, tactical: { basis: 'missing-file' }, agentic: { basis: 'no-rec-hold' } }, skips: [{ action: 'HOLD' }] });
  const result = buildSimFreshness(input);
  assert.equal(result.sources.settlement.date, old);
  assert.equal(result.sources.settlement.latestAttemptDate, date);
  assert.match(result.reasons.join(' '), /不计为有效结算更新/);
  assert.equal(buildSimFreshness({ ...input, accountId: 'main' }).stale, false);
  assert.equal(buildSimFreshness({ ...input, accountId: 'agentic' }).stale, true);
});

test('a fresh account cannot hide another account with unknown holdings date', () => {
  const input = fixture();
  input.holdings[0].asOf = null;
  const result = buildSimFreshness(input);
  assert.equal(result.sources.holdings.date, date);
  assert.match(result.reasons.join(' '), /main持仓快照缺失或日期未知/);
  assert.equal(buildSimFreshness({ ...input, accountId: 'agentic' }).stale, false);
});

test('markdown-only recommendation and future dates remain visibly unverified', () => {
  const input = fixture();
  input.recommendations[0].format = 'md';
  assert.match(buildSimFreshness(input).reasons.join(' '), /缺少有效推荐 JSON/);
  input.actuals[0].date = '2026-09-15';
  assert.match(buildSimFreshness(input).reasons.join(' '), /晚于观察日/);
});

test('observation day uses US sessions rather than local calendar weekend', () => {
  assert.equal(lastSessionStamp(new Date('2026-09-13T12:00:00Z')), old);
  assert.equal(lastSessionStamp(new Date('2026-09-14T12:00:00Z')), date);
});

test('read-only API state reads independent sources, local actuals, JSON-only recs; never seeds files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-sim-freshness-'));
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { getSimState } from './src/sim.js';
    import { DATA_DIR, OBSIDIAN_CHATGPT_RECS, OBSIDIAN_HOLDINGS, lastSessionStamp } from './src/paths.js';
    const date = lastSessionStamp();
    const ids = ['main', 'tactical', 'agentic'];
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(OBSIDIAN_HOLDINGS, { recursive: true });
    const accounts = ids.map(id => ({ id, label: id, holdingsFile: id + '.md' }));
    await writeFile(join(DATA_DIR, 'accounts.json'), JSON.stringify({ desks: [{ id: 'grok', accounts }, { id: 'chatgpt', writable: false, accounts }] }));
    for (const id of ids) await writeFile(join(OBSIDIAN_HOLDINGS, id + '.json'), JSON.stringify({ asOf: date, positions: [], cash: 5000 }));
    globalThis.fetch = () => { throw new Error('read-only sim must not contact a broker or quote provider'); };
    const empty = await getSimState();
    assert.equal(empty.lastDate, null);
    assert.equal(empty.chatgpt.freshness.all.sources.recommendation.date, null);
    assert.equal(empty.chatgpt.freshness.all.sources.actual.date, null);
    assert.ok(!(await readdir(DATA_DIR)).includes('sim'));
    await mkdir(join(DATA_DIR, 'actuals', 'chatgpt'), { recursive: true });
    await writeFile(join(DATA_DIR, 'actuals', 'chatgpt', date + '.json'), JSON.stringify({ date, entries: [] }));
    await mkdir(OBSIDIAN_CHATGPT_RECS, { recursive: true });
    await writeFile(join(OBSIDIAN_CHATGPT_RECS, date + '.json'), JSON.stringify({ date, orders: [] }));
    await mkdir(join(DATA_DIR, 'sim'), { recursive: true });
    const book = { id: 'sim-chatgpt', accounts: Object.fromEntries(ids.map(id => [id, { positions: [], equity: 5000 }])), history: [{ date: '2026-08-25', plans: Object.fromEntries(ids.map(id => [id, { basis: 'daily-rec' }])), fills: [{ accountId: 'main', symbol: 'TEST' }] }, { date, plans: Object.fromEntries(ids.map(id => [id, { basis: 'missing-file' }])), fills: [] }] };
    const path = join(DATA_DIR, 'sim', 'sim-chatgpt.json');
    await writeFile(path, JSON.stringify(book));
    const before = await readFile(path, 'utf8');
    const state = await getSimState('all', '2026-08-25');
    const result = state.chatgpt.freshness.all;
    assert.equal(state.observationDate, date);
    assert.equal(result.sources.recommendation.date, date);
    assert.equal(result.sources.actual.date, date);
    assert.equal(result.sources.settlement.date, '2026-08-25');
    assert.equal(result.sources.settlement.latestAttemptDate, date);
    assert.equal(result.stale, true);
    assert.equal(state.liveTrading, false);
    assert.equal(state.compare.all.chatgptFills, 0);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.ok(!(await readdir(join(DATA_DIR, 'sim'))).includes('sim-grok.json'));
    await writeFile(join(OBSIDIAN_CHATGPT_RECS, date + '.json'), 'null');
    await writeFile(join(DATA_DIR, 'actuals', 'chatgpt', date + '.json'), 'false');
    const invalid = await getSimState();
    assert.equal(invalid.chatgpt.freshness.all.sources.recommendation.date, null);
    assert.equal(invalid.chatgpt.freshness.all.sources.actual.date, null);
    console.log('read-only-freshness-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env, KAWAII_DATA_DIR: join(dir, 'data'), OBSIDIAN_HOLDINGS: join(dir, 'holdings'),
      OBSIDIAN_CHATGPT: join(dir, 'chatgpt'), OBSIDIAN_CHATGPT_RECS: join(dir, 'recs'), OBSIDIAN_CHATGPT_ACTUALS: join(dir, 'actuals'),
      OBSIDIAN_VAULT: join(dir, 'grok'), OBSIDIAN_RECS: join(dir, 'grok-recs')
    }
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /read-only-freshness-ok/);
});
