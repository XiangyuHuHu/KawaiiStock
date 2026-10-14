import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../src/paths.js';
import { refreshForumAggregate } from '../src/bot/forum-aggregate.js';
import { BOX_FORUM_ROOT, BOX_LEDGER_DIR } from '../src/bot/forum-prefetch.js';

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
const watchlistPath = arg('--watchlist') || join(root, 'state', 'watchlist.json');
let watchlist = await readJson(watchlistPath).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (!watchlist) watchlist = await readJson(join(ROOT, 'docs/us-forum-watchlist.example.json'));
let readmeText = '';
try {
  readmeText = await readFile(join(ROOT, 'docs/forum-scan-prefetch.md'), 'utf8');
} catch {
  readmeText = '';
}
const offline = process.argv.includes('--offline');
const result = await refreshForumAggregate({
  root,
  ledgerDir: arg('--ledger-dir') || BOX_LEDGER_DIR,
  watchlist,
  xNews: await readJson(arg('--x-news')),
  now: arg('--now') ? new Date(arg('--now')) : new Date(),
  days: arg('--days') ? Number(arg('--days')) : 14,
  offline,
  readmeText,
  fixtures: offline ? {
    quotes: await readJson(arg('--quotes')),
    robinhood: await readJson(arg('--robinhood')),
    earnings: (await readJson(arg('--earnings')))?.rows || (await readJson(arg('--earnings'))) || [],
    rss: await readJson(arg('--rss')),
    tickers: await readJson(arg('--tickers')),
    submissions: await readJson(arg('--edgar'))
  } : null
});
console.log(JSON.stringify({
  silent: result.silent,
  no_change: result.aggregate.no_change,
  newCount: result.aggregate.newCount,
  newFingerprints: result.aggregate.newFingerprints,
  duplicateCount: result.aggregate.duplicateCount,
  checklist: result.aggregate.checklist,
  playbookChecklist: result.playbookChecklist,
  errors: result.aggregate.errors
}, null, 2));
if (process.argv.includes('--exit-code')) process.exit(result.silent ? 0 : 10);
