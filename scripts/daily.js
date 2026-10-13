import { readFile } from 'node:fs/promises';
import { runDailyJob } from '../src/daily.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const scansPath = arg('--scans');
let extra = {};
if (scansPath) {
  extra = JSON.parse(await readFile(scansPath, 'utf8'));
}

const result = await runDailyJob({
  date: arg('--date') || extra.date,
  scans: extra.scans || {
    ...(extra.tactical ? { tactical: extra.tactical } : {}),
    ...(extra.agentic ? { agentic: extra.agentic } : {})
  },
  scanErrors: extra.scanErrors || {},
  scanFailed: arg('--failed') || extra.scanFailed || '',
  fills: extra.fills || [],
  skipScan: !scansPath && !arg('--failed'),
  skipPaperAuto: process.argv.includes('--skip-paper'),
  forceSim: process.argv.includes('--force-sim'),
  forceRecs: process.argv.includes('--force-recs')
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok || result.verify?.ok === false) {
  console.error('每日任务未全部完成：' + (result.completion?.errors || []).map(r => `${r.label}：${r.reason}`).join('；'));
  process.exit(1);
}
if (result.verify?.complete === false) {
  console.error('每日任务不完整，缺文件：\n' + (result.verify.missing || []).join('\n'));
  process.exit(1);
}
