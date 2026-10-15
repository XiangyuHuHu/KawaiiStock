import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assessHeartbeat } from '../src/bot/heartbeat.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

async function readJson(path) {
  if (!path) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

const inputPath = arg('--input');
const routineArg = arg('--routine');
const outPath = arg('--out') || (routineArg === 'main-trailing' ? 'data/bot/main-trailing.json' : 'data/bot/heartbeat.json');
const input = inputPath ? await readJson(inputPath) : {};
if (routineArg) input.routine = routineArg;
if (arg('--state')) input.state = await readJson(arg('--state'));
const previous = inputPath === outPath ? null : await readJson(outPath).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const status = assessHeartbeat(input, previous);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(status, null, 2));
if (process.argv.includes('--exit-code')) process.exit(status.no_change ? 0 : 10);
