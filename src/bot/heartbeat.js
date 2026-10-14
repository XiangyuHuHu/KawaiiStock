import { stableHash } from './hash.js';

/** 止损路径故意比净值更灵敏。进入止损唤醒区后，每次检查都醒，避免决策环在贴止损时沉默。 */
export const HEARTBEAT_DEFAULTS = {
  navWakeBps: 30,
  stopWakePct: 1,
  nearStopPct: 3,
  stopStepPct: 0.5
};

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  const n = num(value);
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pushWake(wakes, wake) {
  const key = `${wake.code}|${wake.symbol || ''}`;
  if (wakes.some((row) => `${row.code}|${row.symbol || ''}` === key)) return;
  wakes.push(wake);
}

export function normalizeBook(input = {}) {
  const rows = input.positions || input.holdings || [];
  const positions = rows.map((row) => {
    const qtyRaw = num(row.qty ?? row.quantity);
    const side = String(row.side || (qtyRaw != null && qtyRaw < 0 ? 'short' : 'long')).toLowerCase();
    const last = num(row.last ?? row.price ?? row.mark);
    const stop = num(row.stop ?? row.stopPrice ?? row.stop_price);
    let stopDistancePct = num(row.stopDistancePct ?? row.stop_distance_pct ?? row.distanceToStopPct);
    if (stopDistancePct == null && last > 0 && stop != null) {
      stopDistancePct = side === 'short'
        ? ((stop - last) / last) * 100
        : ((last - stop) / last) * 100;
    }
    return {
      symbol: String(row.symbol || row.ticker || '').trim().toUpperCase(),
      side: side === 'short' ? 'short' : 'long',
      qty: round(Math.abs(qtyRaw ?? 0), 4),
      last: round(last, 4),
      stop: round(stop, 4),
      stopDistancePct: round(stopDistancePct, 4)
    };
  }).filter((row) => row.symbol);
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.side.localeCompare(b.side) || a.qty - b.qty);
  return {
    nav: round(num(input.nav ?? input.equity ?? input.accountValue), 2),
    positions
  };
}

function hasBook(input) {
  return Boolean(input && (input.positions || input.holdings || input.nav != null || input.equity != null || input.accountValue != null));
}

function previousBook(previous) {
  if (!previous) return null;
  if (previous.book) return normalizeBook(previous.book);
  if (hasBook(previous)) return normalizeBook(previous);
  return null;
}

function positionKey(row) {
  return `${row.symbol}|${row.side}|${row.qty}`;
}

export function assessHeartbeat(input = {}, previous = null, options = {}) {
  const opts = { ...HEARTBEAT_DEFAULTS, ...options };
  const book = hasBook(input) ? normalizeBook(input) : null;
  const prevBook = previousBook(previous);
  const stateHash = input.stateHash || (input.state ? stableHash(input.state) : null);
  const prevStateHash = previous?.stateHash || null;
  const wakes = [];

  if (!previous) pushWake(wakes, { code: 'baseline', detail: '没有上一份状态，先看一次' });

  if (book) {
    for (const row of book.positions) {
      if (row.stopDistancePct != null && row.stopDistancePct <= opts.stopWakePct + 1e-9) {
        pushWake(wakes, { code: 'stop-near', symbol: row.symbol, stopDistancePct: round(row.stopDistancePct, 2) });
      }
    }
  }

  if (previous && book && prevBook) {
    const currentKeys = book.positions.map(positionKey).join(',');
    const previousKeys = prevBook.positions.map(positionKey).join(',');
    if (currentKeys !== previousKeys) pushWake(wakes, { code: 'positions', detail: '持仓代码、方向或数量变了' });
    const prevBy = new Map(prevBook.positions.map((row) => [`${row.symbol}|${row.side}`, row]));
    for (const row of book.positions) {
      const old = prevBy.get(`${row.symbol}|${row.side}`);
      if (!old) continue;
      if (row.stop == null && old.stop != null) pushWake(wakes, { code: 'stop-missing', symbol: row.symbol });
      if (row.stop != null && old.stop != null && Math.abs(row.stop - old.stop) > 1e-6) {
        pushWake(wakes, { code: 'stop-moved', symbol: row.symbol });
      }
      const alreadyNear = wakes.some((wake) => wake.code === 'stop-near' && wake.symbol === row.symbol);
      if (!alreadyNear && row.stopDistancePct != null && old.stopDistancePct != null) {
        const worse = old.stopDistancePct - row.stopDistancePct;
        if (row.stopDistancePct <= opts.nearStopPct && worse >= opts.stopStepPct - 1e-9) {
          pushWake(wakes, { code: 'stop-closer', symbol: row.symbol, stopDistancePct: round(row.stopDistancePct, 2) });
        }
      }
    }
    if (book.nav != null && prevBook.nav != null && prevBook.nav !== 0) {
      const bps = (Math.abs(book.nav - prevBook.nav) / Math.abs(prevBook.nav)) * 10000;
      if (bps > opts.navWakeBps) pushWake(wakes, { code: 'nav', bps: round(bps, 1) });
    } else if ((book.nav == null) !== (prevBook.nav == null)) {
      pushWake(wakes, { code: 'nav-missing' });
    }
  } else if (previous && book && !prevBook) {
    pushWake(wakes, { code: 'positions', detail: '上一份没有持仓快照' });
  }

  if (stateHash || prevStateHash) {
    if (!previous) {
      /* baseline already recorded */
    } else if (stateHash !== prevStateHash) {
      pushWake(wakes, { code: 'state-hash' });
    }
  }

  const noChange = wakes.length === 0;
  return {
    no_change: noChange,
    routine: input.routine || opts.routine || 'decision',
    checkedAt: opts.now || new Date().toISOString(),
    fingerprint: stableHash({ book: book ? { nav: book.nav, positions: book.positions.map(({ symbol, side, qty, stop }) => ({ symbol, side, qty, stop })) } : null, stateHash }),
    stateHash,
    reason: noChange ? '持仓、净值和止损距离都没有实质性变化' : [...new Set(wakes.map((wake) => wake.code))].join(','),
    wakes,
    book,
    liveTrading: false
  };
}
