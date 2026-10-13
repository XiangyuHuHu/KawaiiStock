import { classifyBars } from './cycle.js';
import { RESEARCH_RULES, sizeConfirmed } from './confirmation.js';

const avg = (xs) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
const round = (n) => n == null ? null : Math.round(n * 10000) / 10000;

export function exitOnBar(position, bar, slip = 0.0005) {
  if (bar.open <= position.stop) return { price: bar.open * (1 - slip), reason: 'gap-stop' };
  // Daily OHLC cannot determine the intraday order: use the adverse outcome.
  if (bar.low <= position.stop) return { price: position.stop * (1 - slip), reason: 'stop' };
  if (bar.high >= position.target) return { price: position.target * (1 - slip), reason: 'target' };
  return null;
}

/** Shared portfolio/execution engine. Both strategies receive only data available at each close. */
export function validateWindow(dataset, { start, end, version = 'v2', slippageBps = 5, classifier = classifyBars } = {}) {
  const qqq = dataset.QQQ?.bars || [];
  const days = qqq.map((bar) => bar.date).filter((day) => day >= start && day <= end);
  const symbols = Object.keys(dataset).filter((symbol) => symbol !== 'QQQ' && dataset[symbol]?.ok).sort();
  const indexed = Object.fromEntries(Object.entries(dataset).map(([symbol, pack]) => [symbol, new Map((pack.bars || []).map((bar, i) => [bar.date, { ...bar, i }]))]));
  const initial = 100000;
  let cash = initial, peak = initial, maxDrawdown = 0, signals = [], exposureSum = 0;
  const positions = new Map(), trades = [], curve = [];
  const slip = slippageBps / 10000;
  let signalsSeen = 0, skipped = 0, staleMarks = 0;
  const equity = () => cash + [...positions.values()].reduce((sum, p) => sum + p.qty * p.last, 0);
  for (const day of days) {
    const navAtOpen = equity(); // prior close only: do not use this session's close for sizing.
    for (const signal of signals.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))) {
      signalsSeen += 1;
      const bar = indexed[signal.symbol].get(day);
      const price = bar?.open * (1 + slip);
      if (!bar || positions.has(signal.symbol) || positions.size >= RESEARCH_RULES.maxPositions || !(price > signal.stop) || price > signal.last * 1.01) { skipped += 1; continue; }
      const risk = [...positions.values()].reduce((sum, p) => sum + Math.max(0, p.last - p.stop) * p.qty, 0);
      const size = sizeConfirmed({ nav: navAtOpen, cash, price, stop: signal.stop, currentRisk: risk });
      if (!size) { skipped += 1; continue; }
      cash -= size.qty * price;
      positions.set(signal.symbol, { symbol: signal.symbol, entryDate: day, signalDate: signal.signalDate, entry: price, last: price, stop: signal.stop, target: price + (price - signal.stop) * RESEARCH_RULES.targetR, qty: size.qty, held: 0 });
    }
    for (const [symbol, pos] of positions) {
      const bar = indexed[symbol].get(day);
      if (!bar) { staleMarks += 1; continue; }
      pos.held += 1;
      pos.last = bar.close;
      let exit = exitOnBar(pos, bar, slip);
      if (!exit && (pos.held >= RESEARCH_RULES.maxHoldBars || day === days.at(-1))) exit = { price: bar.close * (1 - slip), reason: day === days.at(-1) ? 'window-end' : 'time-exit' };
      if (exit) {
        cash += pos.qty * exit.price;
        trades.push({ ...pos, exitDate: day, exit: exit.price, reason: exit.reason, netPnl: (exit.price - pos.entry) * pos.qty, netPct: (exit.price / pos.entry - 1) * 100, r: (exit.price - pos.entry) / (pos.entry - pos.stop) });
        positions.delete(symbol);
      }
    }
    const nav = equity();
    peak = Math.max(peak, nav);
    maxDrawdown = Math.max(maxDrawdown, (peak - nav) / peak * 100);
    const exposure = [...positions.values()].reduce((sum, p) => sum + p.last * p.qty, 0) / nav;
    exposureSum += exposure;
    curve.push({ date: day, nav: round(nav), cash: round(cash), positions: positions.size });
    signals = [];
    if (day === days.at(-1)) continue;
    const benchmarkBars = qqq.filter((bar) => bar.date <= day);
    for (const symbol of symbols) {
      const bar = indexed[symbol].get(day);
      if (!bar || bar.i < 60 || positions.has(symbol)) continue;
      const bars = dataset[symbol].bars.slice(0, bar.i + 1);
      const strategy = classifier(bars, { qqqBars: benchmarkBars, version });
      if (strategy.allowNewLong) signals.push({ ...strategy, symbol, signalDate: day });
    }
  }
  const wins = trades.filter((t) => t.netPnl > 0), losses = trades.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0), grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const first = indexed.QQQ?.get(days[0]), last = indexed.QQQ?.get(days.at(-1));
  const benchmarkReturn = first?.open > 0 && last?.close > 0 ? (last.close * (1 - slip) / (first.open * (1 + slip)) - 1) * 100 : null;
  return { version, start: days[0], end: days.at(-1), sessions: days.length, signalsSeen, skipped, trades: trades.length, winRate: trades.length ? round(wins.length / trades.length * 100) : null,
    netReturnPct: round((equity() / initial - 1) * 100), maxDrawdownPct: round(maxDrawdown), expectancyR: round(avg(trades.map((t) => t.r))), averageNetTradePct: round(avg(trades.map((t) => t.netPct))), profitFactor: grossLoss ? round(grossWin / grossLoss) : null,
    averageExposurePct: round(days.length ? exposureSum / days.length * 100 : null), benchmarkReturnPct: round(benchmarkReturn), halfBenchmarkCashReturnPct: round(benchmarkReturn == null ? null : benchmarkReturn / 2),
    slippageBpsPerSide: slippageBps, staleMarks, openPositions: positions.size, curve, tradeDetails: trades };
}
