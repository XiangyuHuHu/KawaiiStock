import { loadManyHistoricals } from '../src/historicals.js';
import { sessionClosed } from '../src/market-time.js';
import { replayPullbackSignals, US_PULLBACK, US_PULLBACK_V1 } from '../src/paper/limit-pullback.js';
import { loadXiaomengUsFallback } from '../src/paper/xiaomeng-universe.js';
import { loadMarketCaps } from '../src/quotes.js';

const failRules = { ...US_PULLBACK_V1, id: 'us-v1-fail', missingMicrostructure: 'fail' };

const book = await loadXiaomengUsFallback();
const symbols = book.symbols;
const history = await loadManyHistoricals(symbols, { concurrency: 4 });
const barsBySymbol = {};
const now = new Date();
for (const symbol of symbols) {
  const bars = (history[symbol]?.bars || []).filter((bar) => sessionClosed(bar.date, now));
  if (bars.length) barsBySymbol[symbol] = bars;
}
const caps = await loadMarketCaps(symbols);
const inBand = symbols.filter((symbol) => caps[symbol] >= US_PULLBACK.minFloat && caps[symbol] <= US_PULLBACK.maxFloat);
const from = '2026-07-01';
const input = {
  market: 'us',
  barsBySymbol,
  lists: book.listOf,
  members: book.members,
  caps,
  from
};
const v1 = replayPullbackSignals({ ...input, rules: US_PULLBACK_V1 });
const v1Fail = replayPullbackSignals({ ...input, rules: failRules });
const v2 = replayPullbackSignals({ ...input, rules: US_PULLBACK });
const months = new Set(v2.events.map((row) => row.date.slice(0, 7)));
console.log(JSON.stringify({
  universe: book.universe,
  symbols: symbols.length,
  withCap: symbols.filter((symbol) => caps[symbol] > 0).length,
  inV2Band: inBand,
  from,
  v1: { signals: v1.signals, days: v1.days },
  v1Fail: { signals: v1Fail.signals, days: v1Fail.days },
  v2: { signals: v2.signals, days: v2.days, perMonth: months.size ? Number((v2.signals / months.size).toFixed(2)) : 0, events: v2.events }
}, null, 2));
