import { escapeHtml, versionLabel } from './watch-view.js';

export const STAGE_ORDER = [
  { id: 'reversal-extension', label: 'Reversal Extension' },
  { id: 'wedge-pop', label: 'Wedge Pop' },
  { id: 'ema-crossback', label: 'EMA Crossback' },
  { id: 'base-n-break', label: "Base 'n Break" },
  { id: 'exhaustion-extension', label: 'Exhaustion Extension' },
  { id: 'wedge-drop', label: 'Wedge Drop' }
];

export function stageRateOf(score, stage) {
  const book = score?.locked?.byStage;
  if (!book) return null;
  if (stage && book[stage]) return book[stage];
  return Object.values(book).find((row) => row.label === stage) || null;
}

export function rateText(stats, empty = '命中率待结算') {
  if (!stats?.n) return empty;
  return `次日命中 ${stats.rate}%（${stats.hits}/${stats.n}）`;
}

export function versionRateText(row, score) {
  const version = row?.strategy?.version || row?.version;
  const stage = row?.strategy?.stage || row?.stage;
  if (!version) return '版本未知，未合并历史命中率';
  return `${versionLabel(version)} 精选 · ${rateText(score?.locked?.byVersion?.[version]?.byStage?.[stage], '本版命中率待结算')}`;
}

export function strategyLine(row, score, fallback = '—') {
  const stage = row?.strategy?.stage || row?.stage || null;
  const label = row?.strategy?.stageLabel || row?.stageLabel || row?.strategyLabel || fallback;
  if (!label || label === '—') return fallback;
  const scoreBit = row?.strategy?.score != null
    ? `${row.strategy.score}分`
    : (row?.score != null ? `${row.score}分` : '');
  const version = row?.strategy?.version || row?.version;
  const stats = version ? score?.locked?.byVersion?.[version]?.byStage?.[stage] : stageRateOf(score, stage) || row?.strategy?.winRate;
  const rate = rateText(stats, version ? '本版命中率待结算' : '命中率待结算');
  return [label.replace(/\s*·\s*胜率.+$/, ''), scoreBit, rate].filter(Boolean).join(' · ');
}

export function stageStripHtml(score) {
  const book = score?.locked?.byStage || {};
  return `<p class="watch-scope-note">精选候选按形态统计 · 仅每日看涨 / 看跌各 3 只，非全观察池。</p><section class="watch-stage-rates">
    ${STAGE_ORDER.map((stage) => {
      const stats = book[stage.id] || {};
      const pending = (score?.pending || []).filter((row) => row.stage === stage.id).length;
      return `<div>
        <span>${stage.label}</span>
        <strong>${stats.n ? `${stats.rate}%` : '—'}</strong>
        <small>${stats.n ? `${stats.hits}/${stats.n} 对` : pending ? '尚未结算' : score?.ok ? '未入选已记录的精选名单' : '尚未读取统计'}${pending ? ` · ${pending} 个待结算` : ''}</small>
      </div>`;
    }).join('')}
  </section>`;
}

export function universeStageHtml(score) {
  const full = score?.universe;
  const all = full?.all || {};
  const pct = (value) => value == null ? '—' : `${value}%`;
  const nextClose = (full?.samples || []).filter((row) => row.reason === 'awaiting-close').map((row) => row.settleDate).filter(Boolean).sort()[0];
  return `<section class="watch-universe-score" aria-label="全观察池形态统计">
    <h3>全观察池形态统计</h3>
    ${all.pending && !all.n ? `<p class="watch-sample-status"><strong>已采集 ${all.pending} 条有效记录，正在等待结算。</strong><br>${nextClose ? `首批需要美东 ${nextClose} 收盘数据。` : '需要下一交易日收盘数据。'}数据到齐后，通过每日任务或「手动更新」计算涨跌率；目前不是没有记录。</p>` : ''}
    <p class="watch-scope-note">独立口径 · 每日每只股票记一次。观察价对比下一交易日收盘；上涨率 / 下跌率是形态之后的实际分布，不预设买卖方向，不与精选命中率合并。</p>
    <p class="watch-scope-note">${full?.firstDate
      ? `完整采集 ${full.firstDate} 至 ${full.lastDate} · ${full.dates.length} 个观察日 · 已记录 ${all.observed} · 已结算 ${all.n} · 待结算 ${all.pending} · 无效记录 ${all.excluded}。`
      : '未采集完整股票池。点击「手动更新」开始记录；旧档只有精选名单或部分卡片，不能补成全池样本。'}${full?.uncollectedDates?.length ? ` 另有 ${full.uncollectedDates.length} 个旧观察日未采集完整股票池，未计入。` : ''}</p>
    <div class="watch-stage-rates">
      ${STAGE_ORDER.map((stage) => {
        const stats = full?.byStage?.[stage.id] || {};
        const empty = !full?.firstDate ? '未采集' : !stats.observed ? '未观察到该形态' : '尚无有效结算';
        return `<div><span>${stage.label}</span>
          <strong class="watch-sample-count">${stats.n ? `上涨 ${pct(stats.upRate)}` : stats.pending ? `${stats.pending} 条待结算` : empty}</strong>
          <small>已采集有效记录 ${(stats.n || 0) + (stats.pending || 0)} 条</small>
          <small>已结算 ${stats.n || 0} · 待结算 ${stats.pending || 0}</small>
          ${stats.n ? `<small>下跌 ${pct(stats.downRate)} · 平盘 ${stats.flat || 0} 个</small><small>平均涨跌 ${pct(stats.avgRet)}</small>` : ''}
          ${stats.awaitingClose ? `<small>${stats.awaitingClose} 个待下一交易日收盘</small>` : ''}
          ${stats.missingBar ? `<small>${stats.missingBar} 个缺下一交易日日线</small>` : ''}
          ${stats.excluded ? `<small>${stats.excluded} 个缺有效观察价等数据，未计入</small>` : ''}
          ${sampleDetailsHtml((full?.samples || []).filter(row => row.stage === stage.id))}
        </div>`;
      }).join('')}
    </div>
    ${sampleDetailsHtml((full?.samples || []).filter(row => !STAGE_ORDER.some(stage => stage.id === row.stage)), '未知形态 / 排除记录')}
    <p class="watch-scope-note">同日股票可能相关；这是前向观察记录，不是实盘收益或回测。当天重复扫描保留首次完整快照，未知形态和过期报价不计入有效样本。</p>
  </section>`;
}

function sampleDetailsHtml(rows, label = '查看逐条记录与原因') {
  if (!rows.length) return '';
  const reason = { 'awaiting-close': '等待下一交易日收盘', 'missing-next-session-bar': '缺下一交易日日线', 'unknown-stage': '未知形态，已排除', 'missing-or-stale-observation-price': '观察价缺失或过期，已排除' };
  return `<details class="watch-sample-details"><summary>${label}（${rows.length}）</summary><ul>${rows.map(row => `<li><strong>${escapeHtml(row.symbol)}</strong> · 观察 ${escapeHtml(row.callDate || '未知')} · 结算 ${escapeHtml(row.settleDate || '未知')}<br>${row.status === 'locked' ? `已结算 · 涨跌 ${row.retPct == null ? '未知' : `${Number(row.retPct).toFixed(2)}%`}` : escapeHtml(reason[row.reason] || '状态未知')} · 观察价日期 ${escapeHtml(row.priceDate || '未知')}</li>`).join('')}</ul></details>`;
}
