const CYCLICAL_SECTOR = /energy|material|basic materials|semiconductor/i;
const SEMI_MEMORY = new Set([
  'MU', 'AMD', 'NVDA', 'AVGO', 'TSM', 'INTC', 'QCOM', 'AMAT', 'LRCX', 'KLAC',
  'ASML', 'TXN', 'NXPI', 'MRVL', 'ARM', 'WDC', 'STX', 'SMCI', 'AMKR', 'ON',
  'MCHP', 'SWKS', 'QRVO', 'GFS', 'UMC', 'ASX', 'CRDO', 'AMBA', 'MPWR', 'ENTG'
]);

export function cyclicalKind({ symbol, sector, company } = {}) {
  const key = String(symbol || '').toUpperCase();
  if (SEMI_MEMORY.has(key) || /memory|semiconductor|芯片|存储/i.test(String(company || ''))) return 'semi-memory';
  if (CYCLICAL_SECTOR.test(String(sector || ''))) return 'cyclical-sector';
  return null;
}

/**
 * Peak forward EPS × a growth multiple blows up memory, semis, energy and materials.
 * Mid-cycle EPS and a lower multiple keep the anchor inside a cycle.
 * When forward EPS is more than twice TTM, blend in DCF and mark confidence low.
 */
export function adjustCyclicalValuation({
  symbol,
  sector,
  company,
  ttmEps,
  forwardEps,
  earningsMultiple,
  dcfValue,
  fairValue
} = {}) {
  const kind = cyclicalKind({ symbol, sector, company });
  const ttm = Number(ttmEps);
  const fwd = Number(forwardEps);
  let multiple = Number(earningsMultiple);
  let fair = Number(fairValue);
  let epsUsed = fwd > 0 ? fwd : (ttm > 0 ? ttm : null);
  let dcfWeight = 0;
  let confidence = null;
  const notes = [];
  if (kind && ttm > 0 && fwd > 0 && Number.isFinite(multiple)) {
    epsUsed = (ttm + Math.min(fwd, ttm * 1.25)) / 2;
    multiple = Math.min(multiple, 16);
    fair = epsUsed * multiple;
    notes.push(`${kind === 'semi-memory' ? '半导体/存储' : '周期行业'}用中周期 EPS ${epsUsed.toFixed(2)}，倍数上限 16（现用 ${multiple.toFixed(1)}）`);
  }
  const fwdToTtm = ttm > 0 && fwd > 0 ? fwd / ttm : null;
  if (fwdToTtm > 2 && Number.isFinite(fair) && fair > 0) {
    confidence = 'Low';
    notes.push(`前瞻 EPS / TTM = ${fwdToTtm.toFixed(2)}，超过 2`);
    if (Number(dcfValue) > 0) {
      fair = fair * 0.5 + Number(dcfValue) * 0.5;
      dcfWeight = 50;
      notes.push('已强制 DCF 权重 50%，并下调置信度');
    } else {
      notes.push('没有可用 DCF，只下调置信度');
    }
  }
  return {
    kind,
    fairValue: Number.isFinite(fair) ? fair : fairValue,
    earningsMultiple: Number.isFinite(multiple) ? multiple : earningsMultiple,
    valuationEps: epsUsed,
    dcfWeight,
    confidence,
    fwdToTtm,
    notes
  };
}

export function anomalyFromMargin(marginOfSafety) {
  if (marginOfSafety != null && Number(marginOfSafety) > 100) {
    return {
      modelAnomaly: true,
      status: 'Model anomaly',
      modelStatusReason: '模型异常：安全边际超过 100%，机会分不采用这次估值',
      opportunityScore: null
    };
  }
  return { modelAnomaly: false };
}

export function fundamentalsAgeDays(fiscalDate, now = new Date()) {
  const ms = Date.parse(fiscalDate || '');
  if (!Number.isFinite(ms)) return null;
  return (now.getTime() - ms) / 86400000;
}

export function fundamentalsStale({ fiscalDate, earningsDate, now = new Date() } = {}) {
  const reasons = [];
  const age = fundamentalsAgeDays(fiscalDate, now);
  if (age != null && age > 30) reasons.push(`财务截止 ${String(fiscalDate).slice(0, 10)}，已超过 30 天`);
  const earnMs = Date.parse(earningsDate || '');
  const fiscalMs = Date.parse(fiscalDate || '');
  if (Number.isFinite(earnMs) && earnMs < now.getTime() && (!Number.isFinite(fiscalMs) || fiscalMs < earnMs)) {
    reasons.push(`已过财报日 ${String(earningsDate).slice(0, 10)}，财务还停在更早的截止日`);
  }
  return { stale: reasons.length > 0, ageDays: age == null ? null : Math.floor(age), reasons };
}
