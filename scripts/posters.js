import { buildAccountPosters, writePosters } from '../src/posters.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const pack = await buildAccountPosters({
  accountId: arg('--account') || 'main',
  deskId: arg('--desk') || 'grok',
  symbol: arg('--symbol') || undefined
});
if (!pack.ok) {
  console.error(pack.error || 'poster-failed');
  process.exit(1);
}
const written = await writePosters(pack);
console.log(JSON.stringify({
  ok: true,
  date: pack.date,
  accountId: pack.accountId,
  count: written.count,
  dir: written.dir,
  symbols: pack.cards.filter((row) => row.ok).map((row) => row.symbol)
}, null, 2));
