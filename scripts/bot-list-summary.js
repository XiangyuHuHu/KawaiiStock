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
const summary = renderListSummary(pack);
const outPath = arg('--out');
if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--exit-code')) process.exit(summary.no_change ? 0 : 10);
