import { readFile } from 'node:fs/promises';
import { adviceFromMarket, buildAndWriteMartinAdvice } from '../src/martin/report.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const inputPath = arg('--input');
const write = !process.argv.includes('--no-write');
const symbols = (arg('--symbols') || '').split(',').map((symbol) => symbol.trim()).filter(Boolean);
const asOf = arg('--date') || undefined;
const reportsDir = arg('--out') || undefined;

const result = inputPath
  ? await buildAndWriteMartinAdvice({
    ...JSON.parse(await readFile(inputPath, 'utf8')),
    ...(asOf ? { asOf } : {}),
    ...(reportsDir ? { reportsDir } : {}),
    write
  })
  : await adviceFromMarket({
    symbols,
    asOf,
    write,
    ...(reportsDir ? { reportsDir } : {})
  });

const report = result.report;
console.log(JSON.stringify({
  ok: true,
  liveTrading: false,
  autoTrade7811: false,
  ownerBot: report.ownerBot,
  audience: report.audience,
  asOf: report.asOf,
  regime: report.regime?.hint || null,
  jsonPath: result.jsonPath,
  mdPath: result.mdPath,
  candidates: report.candidates.length,
  buyRef: report.candidates.filter((row) => row.action === 'BUY_REF').map((row) => row.symbol),
  stopChecklist: report.stopChecklist.length
}, null, 2));
