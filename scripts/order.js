import { checkOrder } from '../src/risk/service.js';
import { loadQuotes } from '../src/quotes.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || '';
}

const symbol = String(arg('--symbol') || '').toUpperCase();
const side = String(arg('--side') || 'buy').toLowerCase();
const book = arg('--book') || 'live';
const qty = Number(arg('--qty') || 0);
const limit = arg('--limit') || arg('--price');
const stop = arg('--stop');
const maxLoss = arg('--max-loss');
const instrument = arg('--instrument') || 'equity';
const theme = arg('--theme') || '';
const id = arg('--id') || undefined;

if (!symbol || !qty) {
  console.error('用法: node scripts/order.js --symbol TEM --side buy --qty 4 --limit 68 --stop 61 --max-loss 27 [--book live|paper-0a|paper-0b|paper-0c] [--id uuid]');
  process.exit(2);
}

const quotes = await loadQuotes([symbol]);
const q = quotes[symbol];
const last = q?.ok && instrument !== 'option' ? q.last : null;

const result = await checkOrder({
  id,
  book,
  accountId: String(book).startsWith('paper')
    ? `paper-${book.includes('0a') ? '0a' : book.includes('0c') ? '0c' : '0b'}`
    : 'agentic',
  symbol,
  side,
  qty,
  instrument,
  theme,
  limitPrice: limit ? Number(limit) : last,
  stopPrice: stop ? Number(stop) : null,
  maxLoss: maxLoss ? Number(maxLoss) : null,
  last,
  inputs: {
    last,
    quoteAt: instrument !== 'option' ? q?.quoteAt : null,
    hasQuote: last != null,
    hasIntra: false,
    hasChain: instrument !== 'option'
  }
});

console.log(JSON.stringify(result, null, 2));
if (!result.decision?.ok) {
  console.error(`Risk Gateway 拒绝：${result.decision?.code} ${result.decision?.message}`);
  process.exit(1);
}
console.error('通过。实盘仍须券商侧止损；本脚本不下 Robinhood 单。');
