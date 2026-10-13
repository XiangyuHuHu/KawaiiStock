import { loadOptionsHistory } from './history.js';
import { loadForward, FORWARD_RULE } from './forward.js';
import { legsOf, MODEL_VERSION } from './contracts.js';

export function compareRecords(snapshot, records = []) {
  const original = snapshot.historicalBuys || snapshot.buys || [];
  const candidates = original.map(row => {
    // Exact scan identity; never borrow an outcome from a later scan of the same ticker.
    const record = snapshot.scanId ? records.find(r => r.scanId === snapshot.scanId && r.symbol === row.symbol) : null;
    const costMatch = record && JSON.stringify(legsOf(row).map(l => [l.contractSymbol, l.expiration, l.strike, l.type, l.side])) === JSON.stringify((record.legs || []).map(l => [l.contractSymbol, l.expiration, l.strike, l.type, l.side]));
    const compatible = costMatch && record.modelVersion === snapshot.modelVersion && record.horizon === row.horizon
      && (record.rule == null || record.rule === FORWARD_RULE)
      && (record.costs?.feePerContract ?? null) === (snapshot.costAssumptions?.feePerContract ?? null);
    const locked = compatible && record.status === 'locked' && Number.isFinite(record.netPnl);
    return { symbol: row.symbol, action: row.originalAction || row.action, contract: row.contract || null,
      entryAt: snapshot.generatedAt || null, horizon: row.horizon || null, modelVersion: snapshot.modelVersion || 'legacy',
      estimate: snapshot.modelVersion === MODEL_VERSION ? row.evEstimate?.perGroup ?? null : null,
      entryCost: compatible ? record.costs?.entryCost ?? null : row.costs?.entryCost ?? null, feePerContract: snapshot.costAssumptions?.feePerContract ?? null,
      targetAt: record?.targetAt ?? row.targetAt ?? null, exitAt: locked ? record.exitAt : null,
      exitValue: locked ? record.exitValue ?? null : null, exitQuotes: locked ? record.exitQuotes : null,
      netPnl: locked ? record.netPnl : null, returnPct: locked && record.costs?.entryCost > 0 ? Math.round(record.netPnl / record.costs.entryCost * 10000) / 100 : null,
      status: record ? compatible ? record.status : 'incompatible' : 'no-baseline',
      reason: record ? compatible ? record.reason : '记录的合约、模型或视界与原扫描不一致，不能合并' : '此扫描没有保存可验证的合约入场/后续报价基线，不能回填实际损益',
      rule: record?.rule || FORWARD_RULE, attempts: record?.attempts || 0 };
  });
  const locked = candidates.filter(r => r.status === 'locked' && r.netPnl != null);
  return { ok: true, scanId: snapshot.scanId || null, date: snapshot.date, generatedAt: snapshot.generatedAt || null,
    modelVersion: snapshot.modelVersion || 'legacy', candidates, counts: { recommended: original.length, locked: locked.length,
      pending: candidates.filter(r => r.status === 'pending').length, unavailable: candidates.filter(r => !['pending', 'locked'].includes(r.status)).length },
    note: '按原始扫描 ID、同一合约与固定观察视界关联。净损益为一组按报价进出的假设结果，非实际成交。历史模型 EV 不是期权回测；无基线不补算。' };
}

export async function loadComparison(key, strategy = 'cov') {
  const snapshot = await loadOptionsHistory(key, strategy);
  if (!snapshot) return null;
  const forward = snapshot.scanId ? await loadForward({ scanId: snapshot.scanId, all: true }) : { records: [], errors: [] };
  return { ...compareRecords(snapshot, forward.records), errors: forward.errors };
}
