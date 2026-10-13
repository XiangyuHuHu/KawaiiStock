import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.js';

/** 文档口径：百分比是权威，美元是 $5,000 对照。 */
export const PCT = {
  maxOrderRiskPct: 3,
  maxSingleRiskPct: 8,
  maxThemeRiskPct: 15,
  maxOptionRiskPct: 15,
  maxDailyLossPct: 6,
  maxWeeklyLossPct: 8,
  protectDrawdownPct: 10,
  killDrawdownPct: 15
};

const SHARED = {
  phase: 1,
  maxPositions: 5,
  maxRejectsPerDay: 5,
  requireStopOnOpen: true,
  requireMaxLoss: true,
  forbidNakedShort: true,
  optionsLimitOnly: true,
  forbidShortDated: true,
  quoteMaxAgeSec: 180,
  chainMaxAgeSec: 900,
  ...PCT
};

export const PAPER_DESKS = {
  '0a': { id: '0a', seed: 1_000_000, label: 'Phase 0A · $1M 财富', book: 'paper-0a' },
  '0b': { id: '0b', seed: 50000, label: 'Phase 0B · $50k 进攻', book: 'paper-0b' },
  '0c': { id: '0c', seed: 5000, label: 'Phase 0C · $5k Alpha', book: 'paper-0c' },
  '0d': { id: '0d', seed: 100_000, label: 'Phase 0D · $100k 算卦', book: 'paper-0d' },
  '0e': { id: '0e', seed: 100_000, label: 'Phase 0E · $100k 期权', book: 'paper-0e' },
  '0f': { id: '0f', seed: 100_000, label: 'Phase 0F · $100k Claude 动量', book: 'paper-0f' },
  '0g': { id: '0g', seed: 100_000, label: 'Phase 0G · 小孟A股 ¥10万', book: 'paper-0g' },
  '0h': { id: '0h', seed: 100_000, label: 'Phase 0H · 小孟美股 $10万', book: 'paper-0h' }
};

export function paperDeskOf(value) {
  const text = String(value || '0b').toLowerCase();
  if (text === 'paper-0a' || text === '0a' || text === 'paper0a') return '0a';
  if (text === 'paper-0c' || text === '0c' || text === 'paper0c') return '0c';
  if (text === 'paper-0d' || text === '0d' || text === 'paper0d') return '0d';
  if (text === 'paper-0e' || text === '0e' || text === 'paper0e') return '0e';
  if (text === 'paper-0f' || text === '0f' || text === 'paper0f') return '0f';
  if (text === 'paper-0g' || text === '0g' || text === 'paper0g') return '0g';
  if (text === 'paper-0h' || text === '0h' || text === 'paper0h') return '0h';
  if (text === 'live') return null;
  return '0b';
}

export function bookKeyOf(book) {
  const text = String(book || 'live').toLowerCase();
  if (text === 'live') return 'live';
  return paperDeskOf(text);
}

export function resolveCaps(nav, limits = {}) {
  const n = Number(nav);
  const pct = (key, fallback) => {
    const p = limits[key] ?? fallback;
    if (Number.isFinite(n) && n > 0 && p != null) return n * Number(p) / 100;
    return null;
  };
  return {
    maxOrderRisk: pct('maxOrderRiskPct', PCT.maxOrderRiskPct),
    maxSingleRisk: pct('maxSingleRiskPct', PCT.maxSingleRiskPct),
    maxThemeRisk: pct('maxThemeRiskPct', PCT.maxThemeRiskPct),
    maxOptionRisk: pct('maxOptionRiskPct', PCT.maxOptionRiskPct),
    maxDailyLoss: pct('maxDailyLossPct', PCT.maxDailyLossPct),
    maxWeeklyLoss: pct('maxWeeklyLossPct', PCT.maxWeeklyLossPct),
    maxPositions: limits.maxPositions ?? 5
  };
}

async function readDeskConfig() {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, 'desk-config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function loadLimits(book = 'live') {
  const config = await readDeskConfig();
  const gateway = config.risk?.gateway || {};
  const desk = paperDeskOf(book);
  const isPaper = desk != null;
  const overlay = !isPaper
    ? (gateway.live || {})
    : (gateway[`paper${desk}`] || (desk === '0b' ? (gateway.paper0b || gateway.paper5k || {}) : {}));
  const seed = isPaper ? (PAPER_DESKS[desk].seed) : null;
  const { live, paper, paper0a, paper0b, paper0c, paper0d, paper0e, paper0f, paper0g, paper0h, paper5k, ...gatewayPct } = gateway;
  return {
    ...SHARED,
    ...gatewayPct,
    phase: isPaper ? 0 : (config.risk?.phaseDefault ?? gateway.phase ?? 1),
    requireMaxLoss: config.risk?.requireMaxLoss ?? SHARED.requireMaxLoss,
    forbidNakedShort: config.risk?.forbidNakedShort ?? SHARED.forbidNakedShort,
    ...overlay,
    book: isPaper ? PAPER_DESKS[desk].book : 'live',
    desk: desk || 'live',
    seed: overlay.seed ?? seed
  };
}
