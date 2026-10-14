import { stableHash } from './hash.js';

const PROMOTE_KEYS = ['promote', 'promoted', 'promotions', 'upgrades', 'adds'];
const DEMOTE_KEYS = ['demote', 'demoted', 'demotions', 'downgrades', 'drops'];
const MOVER_KEYS = ['movers', 'mover', 'move'];
const LIST_LABEL = {
  core: '核心',
  watch: '观察',
  tactical: '战术',
  avoid: '避开',
  bench: '观察',
  hold: '持有'
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function section(pack, keys) {
  for (const key of keys) {
    if (pack?.[key] != null) return asArray(pack[key]);
  }
  return [];
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function symbolOf(row) {
  if (typeof row === 'string') return row.trim().toUpperCase();
  return String(row?.symbol || row?.ticker || row?.code || '').trim().toUpperCase();
}

function labelOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return LIST_LABEL[raw.toLowerCase()] || raw;
}

function actionOf(row) {
  return String(row?.action || row?.change || row?.type || '').toLowerCase();
}

function isPromote(row) {
  return /promote|upgrade|add|升/.test(actionOf(row));
}

function isDemote(row) {
  return /demote|downgrade|drop|remove|降/.test(actionOf(row));
}

function formatMove(row) {
  const symbol = symbolOf(row);
  if (!symbol) return '';
  const from = labelOf(row?.from || row?.fromList || row?.previous || row?.prev);
  const to = labelOf(row?.to || row?.toList || row?.list || row?.next);
  if (from && to) return `${symbol} ${from}→${to}`;
  if (to) return `${symbol} →${to}`;
  if (from) return `${symbol} ${from}`;
  return symbol;
}

function moverPct(row) {
  const points = num(row?.changePct ?? row?.pct ?? row?.change_pct ?? row?.percent);
  if (points != null) return points;
  const frac = num(row?.changeFrac ?? row?.return);
  return frac == null ? null : frac * 100;
}

function formatPct(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatMover(row) {
  const symbol = symbolOf(row);
  if (!symbol) return '';
  const pct = moverPct(row);
  return pct == null ? symbol : `${symbol} ${formatPct(pct)}`;
}

function unique(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function moverSymbol(line) {
  return String(line || '').split(' ')[0];
}

export function renderListSummary(pack = {}, previous = null) {
  const changes = section(pack, ['changes', 'actions', 'diffs']);
  const promote = unique([
    ...section(pack, PROMOTE_KEYS).map(formatMove),
    ...changes.filter(isPromote).map(formatMove)
  ]).sort();
  const demote = unique([
    ...section(pack, DEMOTE_KEYS).map(formatMove),
    ...changes.filter(isDemote).map(formatMove)
  ]).sort();
  const moverRows = [
    ...section(pack, MOVER_KEYS),
    ...section(pack, ['moversUp', 'gainers']),
    ...section(pack, ['moversDown', 'losers'])
  ];
  const movers = unique(moverRows.map(formatMover)).sort((a, b) => a.localeCompare(b));
  const fingerprint = stableHash({ promote, demote, movers });
  const fingerprintUnchanged = Boolean(previous?.fingerprint) && previous.fingerprint === fingerprint;
  const seenPromote = new Set(previous?.promote || []);
  const seenDemote = new Set(previous?.demote || []);
  const seenMovers = new Set(previous?.movers || []);
  const freshPromote = promote.filter((line) => !seenPromote.has(line));
  const freshDemote = demote.filter((line) => !seenDemote.has(line));
  const freshMovers = movers.filter((line) => !seenMovers.has(moverSymbol(line)));
  const base = {
    fingerprint,
    fingerprint_unchanged: fingerprintUnchanged,
    promote,
    demote,
    movers: movers.map(moverSymbol),
    liveTrading: false
  };
  if (fingerprintUnchanged || (!freshPromote.length && !freshDemote.length && !freshMovers.length)) {
    return { ...base, no_change: true, silent: true, text: 'NO_CHANGE' };
  }
  const lines = ['【美股名单】'];
  if (freshPromote.length) lines.push(`升：${freshPromote.join('；')}`);
  if (freshDemote.length) lines.push(`降：${freshDemote.join('；')}`);
  if (freshMovers.length) lines.push(`异动：${freshMovers.join('；')}`);
  return { ...base, no_change: false, silent: false, text: lines.join('\n') };
}
