const book = new Map();

export function resetTape() {
  book.clear();
}

export function rememberTape(symbol, reading = {}) {
  const key = String(symbol || '').toUpperCase();
  const last = Number(reading.last);
  if (!key || !(last > 0)) return null;
  const row = book.get(key) || { symbol: key, sources: [] };
  const source = reading.source || 'unknown';
  const next = {
    last,
    source,
    quoteAt: Number(reading.quoteAt) || null,
    at: Date.now()
  };
  row.sources = [next, ...row.sources.filter((item) => item.source !== source)].slice(0, 6);
  book.set(key, row);
  return priceConflict(key, last, source);
}

export function sharedLast(symbol) {
  const row = book.get(String(symbol || '').toUpperCase());
  if (!row?.sources?.length) return null;
  return [...row.sources].sort((a, b) => (b.quoteAt || b.at || 0) - (a.quoteAt || a.at || 0))[0];
}

export function priceConflict(symbol, price, source) {
  const row = book.get(String(symbol || '').toUpperCase());
  const used = Number(price);
  if (!row || !(used > 0)) return null;
  const other = row.sources.find((item) => item.source !== source && item.last > 0);
  if (!other) return null;
  const gap = Math.abs(used - other.last);
  if (gap < 0.05 && gap / other.last < 0.003) return null;
  return {
    flag: 'price-conflict',
    used,
    other: other.last,
    source: source || 'unknown',
    otherSource: other.source,
    note: `${source || '当前源'} ${used} 与 ${other.source} ${other.last} 不是同一笔行情`
  };
}
