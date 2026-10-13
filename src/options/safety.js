import { evaluateFreshness } from '../risk/freshness.js';
import { todayStamp } from '../paths.js';
import { daysBetween } from './math.js';
import { MODEL_VERSION, isBuy, legsOf, priceStructure } from './contracts.js';
import { regularSession, sessionCloseMs } from './time.js';

export function reassessOptions(pack, now = Date.now()) {
  const fee = pack.costAssumptions?.feePerContract ?? null;
  let admitted = 0;
  const ideas = (pack.ideas || []).map(original => {
    const row = structuredClone(original), legs = legsOf(row);
    const times = row.sourceTimes || {};
    const chainAt = legs.length && legs.every(leg => Number.isFinite(leg.quoteAt) && leg.quoteAt > 0) ? Math.min(...legs.map(leg => leg.quoteAt)) : null;
    const freshness = evaluateFreshness({ ...times, chainAt, requireIntra: true, requireChain: true, requireQuote: true, chainMaxAgeSec: 180 }, now);
    const costs = priceStructure(legs, fee);
    const blockers = [];
    if (pack.modelVersion !== MODEL_VERSION) blockers.push('历史版本缺少完整报价和组合校验，请重新扫描');
    if (!freshness.fresh) blockers.push(...freshness.fields.filter(f => ['missing', 'stale'].includes(f.status)).map(f => `${({quote:'标的报价',intraday:'5分钟K线',chain:'每腿 Bid/Ask 报价'})[f.name] || f.name}${f.status === 'stale' ? '已过期' : '时间缺失'}`));
    if (legs.some(leg => [leg.quoteAt, leg.bidAt, leg.askAt].some(t => t > now + 5000))) blockers.push('合约报价时间在未来');
    if (pack.date !== todayStamp(new Date(now))) blockers.push('观察日不是当前美东日期');
    if (!regularSession(now)) blockers.push('当前不在已核实的美股常规交易时段');
    if (!costs.ok) blockers.push(...costs.issues);
    if (fee == null) blockers.push('手续费未填写，净收益不可评估');
    if (legs.some(leg => { const dte = daysBetween(todayStamp(new Date(now)), leg.expiration); return !(dte >= 3 && dte <= 45); })) blockers.push('到期日不在 3–45 天范围');
    if (!(row.patternMatches >= 20)) blockers.push('独立历史样本少于 20');
    if (!(row.optionEv > 0)) blockers.push('净 EV 缺失或不为正');
    if (row.earningsStatus !== 'not-applicable' && (row.earningsInDays == null || row.earningsInDays < 0)) blockers.push('未来财报日期未核实');
    else if (row.earningsStatus !== 'not-applicable' && row.earningsInDays != null && row.earningsInDays <= Math.max(3, row.horizonDays || 0)) blockers.push('观察视界内临近财报');
    if (row.targetAt && legs.some(l => { try { return sessionCloseMs(l.expiration) <= row.targetAt; } catch { return true; } })) blockers.push('合约到期不晚于观察终点，无法按固定视界取得退出报价');
    if (!row.targetAt) blockers.push('未建立固定观察视界');
    if (row.horizon === '60m' && row.horizonDays > 1 / 24 + 0.000001) blockers.push('60 分钟视界跨交易时段，现有同日历史样本不适用');
    row.originalAction = row.originalAction || row.action;
    row.blockers = [...new Set(blockers)];
    row.freshness = freshness;
    row.costs = pack.modelVersion === MODEL_VERSION ? costs : { ok: false, issues: ['历史模型缺少组合校验，请重新扫描'] };
    row.eligible = !blockers.length && isBuy(row.originalAction);
    if (row.eligible && admitted >= 3) { row.eligible = false; row.blockers.push('超过本轮最多 3 个候选限制'); }
    if (row.eligible) admitted++;
    row.status = row.eligible ? 'RESEARCH' : !freshness.fresh ? 'DATA_UNAVAILABLE' : 'WATCH';
    row.action = row.eligible ? row.originalAction : 'NO_TRADE';
    row.staleBlocked = !freshness.fresh;
    row.contractRole = row.eligible ? 'research' : 'reference';
    if (row.contract) row.contract.role = row.contractRole;
    return row;
  });
  const buys = ideas.filter(row => row.eligible).slice(0, 3);
  return { ...pack, assessedAt: new Date(now).toISOString(), liveTrading: false, ideas, buys,
    tempting: ideas.filter(row => row.tempting && !row.eligible), skipped: ideas.filter(row => !buys.includes(row)),
    counts: { scanned: ideas.length, buy: buys.length, noTrade: ideas.filter(row => !row.eligible).length },
    nonRealtime: ideas.some(row => !row.freshness.fresh) || !ideas.length };
}
