import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

for (const key of [
  'OBSIDIAN_VAULT', 'OBSIDIAN_CHATGPT', 'OBSIDIAN_LISTS', 'OBSIDIAN_CN_LISTS', 'OBSIDIAN_HOLDINGS',
  'KAWAII_LIST_DIR', 'CN_LIST_DIR'
]) delete process.env[key];

const { ROOT, VAULT_PATHS, OBSIDIAN_VAULT, OBSIDIAN_CHATGPT, OBSIDIAN_LISTS, OBSIDIAN_CN_LISTS, OBSIDIAN_HOLDINGS, logMissingPaths } = await import('../src/paths.js');

test('vault defaults stay inside the repo and are not Windows paths', () => {
  assert.equal(OBSIDIAN_VAULT, join(ROOT, 'vault', 'grok'));
  assert.equal(OBSIDIAN_CHATGPT, join(ROOT, 'vault', 'chatgpt'));
  assert.equal(OBSIDIAN_LISTS, join(ROOT, 'vault', 'lists', 'us'));
  assert.equal(OBSIDIAN_CN_LISTS, join(ROOT, 'vault', 'lists', 'cn'));
  assert.equal(OBSIDIAN_HOLDINGS, join(ROOT, 'vault', 'holdings'));
  for (const [name, dir] of VAULT_PATHS) {
    assert.equal(dir.startsWith(join(ROOT, 'vault')), true, name);
    assert.equal(dir.includes('Obsidian'), false, name);
    assert.equal(dir.includes('\\'), false, name);
  }
});

test('startup logs each missing vault path', async () => {
  const warnings = [];
  const rows = await logMissingPaths({ warn: (line) => warnings.push(line) });
  assert.equal(rows.length, VAULT_PATHS.length);
  const missing = rows.filter((row) => row.missing);
  assert.equal(warnings.length, missing.length);
  for (const row of missing) {
    assert.match(warnings.join('\n'), new RegExp(row.name));
    assert.match(warnings.join('\n'), /路径不存在/);
  }
});
