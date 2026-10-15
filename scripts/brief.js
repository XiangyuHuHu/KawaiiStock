import { readFile } from 'node:fs/promises';
import { buildAndWriteAgenticBrief } from '../src/agentic-brief.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const holdingsPath = arg('--holdings');
const extra = holdingsPath ? JSON.parse(await readFile(holdingsPath, 'utf8')) : {};
const pack = await buildAndWriteAgenticBrief({
  date: arg('--date') || extra.date,
  holdings: extra.positions ? extra : extra.holdings,
  recs: extra.recs,
  watchlist: extra.watchlist
});
console.log(JSON.stringify({
  ok: pack.ok,
  date: pack.date,
  stance: pack.stance,
  headline: pack.headline,
  holdings: pack.holdings,
  exit: pack.actions.exit.map((row) => row.symbol),
  hold: pack.actions.hold.map((row) => row.symbol),
  consider: pack.actions.consider.map((row) => row.symbol),
  watch: pack.actions.watch.map((row) => row.symbol)
}, null, 2));
