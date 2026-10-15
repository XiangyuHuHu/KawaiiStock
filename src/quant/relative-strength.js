import { windowReturn } from './indicators.js';

/** 只映射一眼能对上的行业 ETF。对不上就留空，不拿错的板块凑数。 */
export const SECTOR_ETF = {
  MU: 'SMH',
  MRVL: 'SMH',
  INTC: 'SMH',
  CRDO: 'SMH'
};

export function sectorEtfFor(symbol) {
  return SECTOR_ETF[String(symbol || '').toUpperCase()] || null;
}

function scoreExcess(excess) {
  if (excess == null) return null;
  if (excess >= 0.15) return 92;
  if (excess >= 0.08) return 78;
  if (excess >= 0.03) return 66;
  if (excess >= 0) return 55;
  if (excess >= -0.05) return 40;
  return 22;
}

function excessOf(bars, bench, n = 20) {
  const ret = windowReturn(bars, n);
  const benchRet = windowReturn(bench, n);
  if (ret == null || benchRet == null) return { ret, benchRet, excess: null };
  return { ret, benchRet, excess: ret - benchRet };
}

export function relativeStrength({ bars, spyBars, sectorBars, sectorSymbol } = {}) {
  const now = excessOf(bars, spyBars, 20);
  const prev = excessOf((bars || []).slice(0, -5), (spyBars || []).slice(0, -5), 20);
  const sector = excessOf(bars, sectorBars, 20);
  return {
    ret20: now.ret,
    benchmark: spyBars?.length ? 'SPY' : null,
    benchmarkRet20: now.benchRet,
    excess20: now.excess,
    excess20Prev: prev.excess,
    sector: sectorSymbol || null,
    sectorRet20: sector.benchRet,
    sectorExcess20: sector.excess,
    score: scoreExcess(now.excess)
  };
}
