/** Missing financial data must never silently become zero. */
export function finiteNumber(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function instrumentOf(value) {
  const kind = String(value || 'equity').toLowerCase();
  return ['stock', 'equity', 'etf', '2x-etf', '2x-leveraged-equity-etf'].includes(kind) ? 'equity' : kind;
}
