import { buildOptionsDesk, writeOptions } from '../src/options/engine.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const pack = await buildOptionsDesk({
  date: arg('--date') || undefined,
  strategyId: arg('--strategy') || 'cov',
  deskId: arg('--desk') || 'grok',
  feePerContract: arg('--fee') == null || arg('--fee') === '' ? undefined : Number(arg('--fee'))
});

if (process.argv.includes('--write')) {
  pack.written = await writeOptions(pack);
}

console.log(JSON.stringify({
  ok: pack.ok,
  date: pack.date,
  strategy: pack.strategy,
  counts: pack.counts,
  buys: (pack.buys || []).map((row) => ({
    symbol: row.symbol,
    action: row.action,
    cov: row.cov,
    optionEvLabel: row.optionEvLabel,
    contract: row.contract ? `${row.contract.expiration} ${row.contract.strike} ${row.contract.type}` : null,
    reason: row.reason
  })),
  tempting: (pack.tempting || []).map((row) => ({
    symbol: row.symbol,
    cov: row.cov,
    reason: row.reason
  })),
  written: pack.written || null,
  error: pack.error || null
}, null, 2));

if (!pack.ok) process.exit(1);
