import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderListSummary } from '../src/bot/list-summary.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const scanPath = arg('--scan');
if (!scanPath) {
  console.error('用法：node scripts/bot-list-summary.js --scan scan.json [--out file.json]');
  process.exit(2);
}
const pack = JSON.parse(await readFile(scanPath, 'utf8'));
const outPath = arg('--out') || 'data/bot/list-scan.json';
const previous = await readFile(outPath, 'utf8').then((text) => JSON.parse(text)).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const summary = renderListSummary(pack, previous);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--exit-code')) process.exit(summary.no_change ? 0 : 10);
