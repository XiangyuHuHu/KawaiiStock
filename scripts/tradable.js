import { buildTradableDesk, writeTradable } from '../src/tradable.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const pack = await buildTradableDesk({
  date: arg('--date') || undefined,
  deskId: arg('--desk') || 'grok'
});
if (!pack.ok) {
  console.error(pack.error || 'tradable-failed');
  process.exit(1);
}
const written = process.argv.includes('--no-write') ? null : await writeTradable(pack);
console.log(JSON.stringify({
  ok: true,
  date: pack.date,
  count: pack.ideas.length,
  counts: pack.counts,
  written,
  ideas: pack.ideas.map((row) => ({
    accountId: row.accountId,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    price: row.price,
    last: row.last,
    urgency: row.urgency
  }))
}, null, 2));
