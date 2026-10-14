import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../src/paths.js';
import { ackForumItems, BOX_FORUM_ROOT, BOX_LEDGER_DIR, runForumPrefetch } from '../src/bot/forum-prefetch.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

async function readJson(path) {
  if (!path) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

const root = arg('--root') || BOX_FORUM_ROOT;
const ledgerDir = arg('--ledger-dir') || BOX_LEDGER_DIR;
const exitCode = process.argv.includes('--exit-code');

if (arg('--ack')) {
  const body = await readJson(arg('--ack'));
  const result = await ackForumItems({
    root,
    ledgerDir,
    items: Array.isArray(body) ? body : (body.items || [])
  });
  console.log(JSON.stringify(result, null, 2));
  if (exitCode) process.exit(result.silent ? 0 : 10);
} else {
  let readmeText = '';
  try {
    readmeText = await readFile(join(ROOT, 'docs/forum-scan-prefetch.md'), 'utf8');
  } catch {
    readmeText = '';
  }
  const { gate } = await runForumPrefetch({
    root,
    quotes: await readJson(arg('--quotes')),
    xNews: await readJson(arg('--x-news')),
    events: await readJson(arg('--events')),
    readmeText
  });
  console.log(JSON.stringify(gate, null, 2));
  if (exitCode) process.exit(gate.silent ? 0 : 10);
}
