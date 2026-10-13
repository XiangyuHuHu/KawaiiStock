import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkOrder } from '../src/risk/service.js';
import { loadQuotes } from '../src/quotes.js';

function arg(name, argv) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] || '';
}

export function parseOrderArgs(argv = process.argv) {
  return {
    symbol: String(arg('--symbol', argv) || '').toUpperCase(),
    side: String(arg('--side', argv) || 'buy').toLowerCase(),
    book: arg('--book', argv) || 'paper',
    qty: Number(arg('--qty', argv) || 0),
    limit: arg('--limit', argv) || arg('--price', argv),
    stop: arg('--stop', argv),
    maxLoss: arg('--max-loss', argv),
    instrument: arg('--instrument', argv) || 'equity',
    theme: arg('--theme', argv) || '',
    id: arg('--id', argv) || undefined
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main() {
  const {
    symbol, side, book, qty, limit, stop, maxLoss, instrument, theme, id
  } = parseOrderArgs();

  if (!symbol || !qty) {
    console.error('用法: node scripts/order.js --symbol TEM --side buy --qty 4 --limit 68 --stop 61 --max-loss 27 [--book paper|paper-0a|paper-0b|paper-0c|live] [--id uuid]');
    console.error('默认 --book paper。实盘须显式传入 --book live。本脚本不下 Robinhood 单。');
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
}

if (isDirectRun()) {
  await main();
}
