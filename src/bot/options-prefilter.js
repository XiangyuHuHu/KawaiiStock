import { daysBetween } from '../options/math.js';
import { todayStamp } from '../paths.js';

export const OPTIONS_PREFILTER_DEFAULTS = {
  minDte: 2,
  maxDte: 14,
  minAbsDelta: 0.15,
  maxAbsDelta: 0.55,
  maxPremium: 5
};

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function leg(row, underlying, spot, type) {
  return {
    ...row,
    symbol: row.symbol || row.underlying || underlying || null,
    spot: row.spot ?? spot,
    type: row.type || row.right || type || null
  };
}

function contractsOf(dump) {
  if (Array.isArray(dump)) return dump.map((row) => ({ ...row }));
  const out = [];
  const underlying = dump?.underlying || dump?.symbol || null;
  const spot = num(dump?.spot ?? dump?.last);
  for (const row of asArray(dump?.contracts || dump?.options || dump?.chain)) out.push(leg(row, underlying, spot));
  for (const row of asArray(dump?.calls)) out.push(leg(row, underlying, spot, 'call'));
  for (const row of asArray(dump?.puts)) out.push(leg(row, underlying, spot, 'put'));
  for (const chain of asArray(dump?.chains || dump?.underlyings)) {
    const symbol = chain.underlying || chain.symbol || underlying;
    const chainSpot = num(chain.spot ?? chain.last) ?? spot;
    for (const row of asArray(chain.calls)) out.push(leg(row, symbol, chainSpot, 'call'));
    for (const row of asArray(chain.puts)) out.push(leg(row, symbol, chainSpot, 'put'));
    for (const row of asArray(chain.contracts || chain.options)) out.push(leg(row, symbol, chainSpot));
  }
  return out;
}

function money(value) {
  const n = num(value);
  return n == null ? null : Math.round(n * 10000) / 10000;
}

function premiumOf(row) {
  const explicit = num(row.premium ?? row.mid ?? row.mark ?? row.last);
  if (explicit != null) return money(explicit);
  const bid = num(row.bid);
  const ask = num(row.ask);
  if (bid != null && ask != null && ask >= bid) return money((bid + ask) / 2);
  return money(bid ?? ask);
}

function normalizeContract(row, asOf) {
  const expiration = String(row.expiration || row.expiry || row.exp || '').slice(0, 10);
  const givenDte = num(row.dte);
  const dte = givenDte != null ? givenDte : (expiration ? daysBetween(asOf, expiration) : null);
  const delta = num(row.delta);
  const type = String(row.type || row.right || '').toLowerCase().startsWith('p') ? 'put' : 'call';
  return {
    symbol: String(row.symbol || row.underlying || '').trim().toUpperCase(),
    type,
    strike: num(row.strike),
    expiration: /^\d{4}-\d{2}-\d{2}$/.test(expiration) ? expiration : null,
    dte,
    delta,
    absDelta: delta == null ? null : Math.abs(delta),
    premium: premiumOf(row),
    bid: num(row.bid),
    ask: num(row.ask),
    spot: num(row.spot)
  };
}

function reject(reasons, code) {
  reasons.push(code);
}

export function prefilterOptions(dump = {}, caps = {}) {
  const opts = { ...OPTIONS_PREFILTER_DEFAULTS };
  for (const [key, value] of Object.entries(caps)) {
    if (value !== undefined && value !== null && value !== '') opts[key] = value;
  }
  const maxPremium = opts.maxPremium === 'none' ? null : num(opts.maxPremium);
  const asOf = opts.asOf || todayStamp();
  const candidates = [];
  let rejectedCount = 0;
  const blockedShortDated = [];
  for (const raw of contractsOf(dump)) {
    const row = normalizeContract(raw, asOf);
    const reasons = [];
    if (!row.symbol) reject(reasons, 'symbol-missing');
    if (row.dte == null) reject(reasons, 'dte-missing');
    else if (row.dte < opts.minDte) reject(reasons, row.dte <= 1 ? 'short-dated-blocked' : 'dte-below-min');
    else if (row.dte > opts.maxDte) reject(reasons, 'dte-above-max');
    if (row.absDelta == null) reject(reasons, 'delta-missing');
    else if (row.absDelta < opts.minAbsDelta || row.absDelta > opts.maxAbsDelta) reject(reasons, 'delta-outside');
    if (row.premium == null) reject(reasons, 'premium-missing');
    else if (maxPremium != null && row.premium > maxPremium) reject(reasons, 'premium-above-cap');
    if (reasons.length) {
      rejectedCount += 1;
      if (reasons.includes('short-dated-blocked')) {
        blockedShortDated.push({ symbol: row.symbol, expiration: row.expiration, dte: row.dte, type: row.type, strike: row.strike });
      }
      continue;
    }
    candidates.push({
      ...row,
      premiumCost: Math.round(row.premium * 100 * 100) / 100
    });
  }
  candidates.sort((a, b) => a.symbol.localeCompare(b.symbol) || String(a.expiration).localeCompare(String(b.expiration)) || a.strike - b.strike || a.type.localeCompare(b.type));
  return {
    liveTrading: false,
    orderPlacement: 'bot-and-connector-only',
    no_change: candidates.length === 0,
    asOf,
    caps: {
      minDte: opts.minDte,
      maxDte: opts.maxDte,
      minAbsDelta: opts.minAbsDelta,
      maxAbsDelta: opts.maxAbsDelta,
      maxPremium
    },
    candidates,
    rejectedCount,
    blockedShortDated,
    note: '候选表只供 bot 确认。本脚本不下单、不撤单。0DTE/1DTE 不会进入候选。'
  };
}
