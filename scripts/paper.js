import { getPaperView, placePaperOrder, resetPaper } from '../src/paper/desk.js';
import { runPaperOpen } from '../src/paper/auto.js';
import { buildRecommendations } from '../src/recommend.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const desk = arg('--desk') || (process.argv.includes('--auto') ? 'all' : '0b');

if (process.argv.includes('--auto')) {
  let recs = null;
  try { recs = await buildRecommendations({ advisor: 'grok' }); } catch { recs = null; }
  const result = await runPaperOpen({ desk, recs, force: process.argv.includes('--force') });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv.includes('--reset')) {
  console.log(JSON.stringify(await resetPaper(desk), null, 2));
  process.exit(0);
}

if (process.argv.includes('--order')) {
  const result = await placePaperOrder({
    desk,
    symbol: arg('--symbol'),
    side: arg('--side') || 'buy',
    qty: Number(arg('--qty') || 0),
    limitPrice: arg('--limit') ? Number(arg('--limit')) : undefined,
    stopPrice: arg('--stop') ? Number(arg('--stop')) : undefined,
    maxLoss: arg('--max-loss') ? Number(arg('--max-loss')) : undefined,
    instrument: arg('--instrument') || 'equity',
    theme: arg('--theme') || '',
    note: arg('--note') || 'paper-cli'
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

console.log(JSON.stringify(await getPaperView(desk), null, 2));
