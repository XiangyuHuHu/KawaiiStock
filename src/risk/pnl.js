import { todayStamp, weekStamp } from '../paths.js';
import { loadActualFiles } from '../actuals.js';
import { bookState, loadRiskState, touchBook } from './state.js';

const CLOSE = new Set(['SELL', 'TRIM', 'EXIT']);
const OPEN = new Set(['BUY', 'ADD']);

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Agentic 实际操作 FIFO 已实现盈亏。只喂 live Gateway，不把战术账混进来。 */
export async function realizedAgenticFromActuals({ date, week } = {}) {
  const day = date || todayStamp();
  const weekStart = week || weekStamp(day);
  const files = await loadActualFiles('grok');
  const lots = new Map();
  let pnlDay = 0;
  let pnlWeek = 0;
  const dayFills = [];
  const weekFills = [];

  const chronological = [...files].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const file of chronological) {
    const entries = [...(file.entries || [])].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const row of entries) {
      if (row.accountId !== 'agentic') continue;
      const symbol = String(row.symbol || '').toUpperCase();
      const side = String(row.side || '').toUpperCase();
      const qty = Math.abs(Number(row.qty) || 0);
      const price = Number(row.price);
      if (!symbol || !(qty > 0) || !Number.isFinite(price)) continue;
      if (OPEN.has(side)) {
        const stack = lots.get(symbol) || [];
        stack.push({ qty, price });
        lots.set(symbol, stack);
        continue;
      }
      if (!CLOSE.has(side)) continue;
      let remain = qty;
      let realized = 0;
      const stack = lots.get(symbol) || [];
      while (remain > 0 && stack.length) {
        const lot = stack[0];
        const take = Math.min(lot.qty, remain);
        realized += take * (price - lot.price);
        lot.qty = round2(lot.qty - take);
        remain = round2(remain - take);
        if (lot.qty <= 1e-8) stack.shift();
      }
      if (remain > 0) {
        realized += remain * 0;
      }
      lots.set(symbol, stack);
      const fill = {
        date: file.date,
        symbol,
        side,
        qty,
        price,
        realized: round2(realized)
      };
      if (file.date === day) {
        pnlDay += realized;
        dayFills.push(fill);
      }
      if (file.date >= weekStart && file.date <= day) {
        pnlWeek += realized;
        weekFills.push(fill);
      }
    }
  }

  return {
    accountId: 'agentic',
    date: day,
    weekStart,
    pnlDay: round2(pnlDay),
    pnlWeek: round2(pnlWeek),
    dayFills,
    weekFills,
    note: 'Agentic 实际操作 FIFO。买入不计入已实现；卖出/减仓才计。不是下单。'
  };
}

export async function syncLiveActualsPnl() {
  const realized = await realizedAgenticFromActuals();
  const state = await loadRiskState(realized.date);
  const slice = bookState(state, 'live');
  if (slice.pnlDay === realized.pnlDay && slice.pnlWeek === realized.pnlWeek) {
    return { ok: true, changed: false, ...realized, mode: slice.mode };
  }
  const saved = await touchBook(state, 'live', {
    pnlDay: realized.pnlDay,
    pnlWeek: realized.pnlWeek,
    actualsSyncAt: new Date().toISOString()
  });
  return {
    ok: true,
    changed: true,
    ...realized,
    mode: saved.books?.live?.mode || slice.mode
  };
}
