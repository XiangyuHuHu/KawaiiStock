import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('manual narrative update persists snapshots, keeps stale dates honest and preserves authored narrative', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-narrative-test-'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { DATA_DIR, REPORTS_DIR, OBSIDIAN_DAILY, todayStamp } from './src/paths.js';
    import { writeAgenticNarrative } from './src/narrative.js';
    import { loadDailyReports } from './src/reports.js';
    await mkdir(join(DATA_DIR, 'holdings'), { recursive: true });
    await writeFile(join(DATA_DIR, 'accounts.json'), JSON.stringify({ desks: [{ id: 'grok', accounts: [{ id: 'agentic', holdingsStem: 'test', source: 'robinhood' }] }] }));
    const holdingsPath = join(DATA_DIR, 'holdings', 'test.json');
    const date = todayStamp();
    const source = JSON.stringify({ asOf: '2026-08-21', positions: [], cash: 1000 });
    await writeFile(holdingsPath, source);
    globalThis.fetch = () => { throw new Error('unexpected network/broker request'); };
    const report = await writeAgenticNarrative({ date, preserveAuthored: true });
    assert.equal(report.stale, true);
    assert.equal(report.asOf, '2026-08-21');
    assert.equal(report.liveTrading, false);
    assert.ok(report.generatedAt);
    assert.match(report.markdown, /不是今日实时持仓/);
    assert.equal(await readFile(holdingsPath, 'utf8'), source);
    assert.equal(await readFile(join(REPORTS_DIR, date + '.md'), 'utf8'), await readFile(join(OBSIDIAN_DAILY, date + '.md'), 'utf8'));
    assert.equal((await loadDailyReports())[0].stale, true);
    await writeFile(holdingsPath, JSON.stringify({ positions: [], cash: 1000 }));
    const unknown = await writeAgenticNarrative({ date, preserveAuthored: true });
    assert.equal(unknown.asOf, null);
    assert.equal(unknown.stale, true);
    assert.equal(unknown.stance, 'WAIT');
    const authored = '---\nsource: council\ndate: ' + date + '\n---\n# Council 原文\n必须保留。\n';
    await writeFile(join(OBSIDIAN_DAILY, date + '.md'), authored);
    const preserved = await writeAgenticNarrative({ date, preserveAuthored: true });
    assert.equal(preserved.preserved, true);
    assert.equal(await readFile(join(OBSIDIAN_DAILY, date + '.md'), 'utf8'), authored);
    assert.deepEqual((await readdir(DATA_DIR)).sort(), ['accounts.json', 'holdings']);
    console.log('narrative-update-ok');
  `], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env, KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_DAILY: join(dir, 'daily'), OBSIDIAN_HOLDINGS: join(dir, 'holdings')
    }
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /narrative-update-ok/);
});
