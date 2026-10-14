import { stableHash } from './hash.js';

/** routine-prompts-us-v1.3：午间只在净值/止损/持仓指纹变化，或出现新的 -7% 警报时醒来。 */
export const ALERT_DROP_PCT = -7;

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

function dayChangePct(row) {
  const explicit = num(row.changePct ?? row.change_pct ?? row.dayChangePct);
  if (explicit != null) return explicit;
  const prev = num(row.prev ?? row.previousClose ?? row.prevClose);
  const last = num(row.last ?? row.price ?? row.mark);
  if (prev > 0 && last != null) return ((last - prev) / prev) * 100;
  const cost = num(row.avgCost ?? row.averageCost);
  if (cost > 0 && last != null) return ((last - cost) / cost) * 100;
  return null;
}

function alertSymbols(input = {}) {
  const rows = input.positions || input.holdings || [];
  return [...new Set(rows.map((row) => {
    const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
    const pct = dayChangePct(row);
    return symbol && pct != null && pct <= ALERT_DROP_PCT + 1e-9 ? symbol : '';
  }).filter(Boolean))].sort();
}

function middayFingerprint(book) {
  return stableHash({
    nav: book?.nav ?? null,
    positions: (book?.positions || []).map(({ symbol, side, qty, stop }) => ({
      symbol,
      side,
      qty,
      stop: round(stop, 2)
    }))
  });
}

export function assessHeartbeat(input = {}, previous = null, options = {}) {
  const book = hasBook(input) ? normalizeBook(input) : null;
  const stateHash = input.stateHash || (input.state ? stableHash(input.state) : null);
  const fingerprint = middayFingerprint(book);
  const fingerprintUnchanged = Boolean(previous?.fingerprint) && previous.fingerprint === fingerprint;
  const alerts = alertSymbols(input);
  const seen = new Set(previous?.alerts || []);
  const newAlerts = alerts.filter((symbol) => !seen.has(symbol));
  const wakes = [];
  if (!fingerprintUnchanged) pushWake(wakes, { code: 'fingerprint', detail: previous ? '净值、止损或持仓指纹变了' : '没有上一份指纹' });
  for (const symbol of newAlerts) pushWake(wakes, { code: 'alert-7', symbol });
  const noChange = fingerprintUnchanged && newAlerts.length === 0;
  return {
    no_change: noChange,
    silent: noChange,
    routine: input.routine || options.routine || 'midday',
    checkedAt: options.now || new Date().toISOString(),
    fingerprint,
    fingerprint_unchanged: fingerprintUnchanged,
    alerts,
    new_alerts: newAlerts,
    stateHash,
    reason: noChange ? '净值、止损和持仓指纹未变，且没有新的 -7% 警报' : [...new Set(wakes.map((wake) => wake.code))].join(','),
    wakes,
    book,
    liveTrading: false
  };
}
