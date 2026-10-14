import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prefilterOptions } from '../src/bot/options-prefilter.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

function maybeNumber(name) {
  const value = arg(name);
  if (value == null || value === '') return undefined;
  if (value === 'none') return 'none';
  return Number(value);
}

const chainPath = arg('--chain');
if (!chainPath) {
  console.error('用法：node scripts/bot-options-prefilter.js --chain chain.json [--min-dte 2] [--max-dte 14] [--min-delta 0.15] [--max-delta 0.55] [--max-premium 5]');
  process.exit(2);
}
const dump = JSON.parse(await readFile(chainPath, 'utf8'));
const pack = prefilterOptions(dump, {
  minDte: maybeNumber('--min-dte'),
  maxDte: maybeNumber('--max-dte'),
  minAbsDelta: maybeNumber('--min-delta'),
  maxAbsDelta: maybeNumber('--max-delta'),
  maxPremium: maybeNumber('--max-premium'),
  asOf: arg('--as-of') || undefined
});
const outPath = arg('--out');
if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(pack, null, 2));
if (process.argv.includes('--exit-code')) process.exit(pack.no_change ? 0 : 10);
