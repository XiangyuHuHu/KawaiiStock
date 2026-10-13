import { referenceContract, actionLabel, assessment } from './options-display.js';
import { loadWheel, setWheelCandidates } from './wheel.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(2)}`;
const num = value => value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const stamp = value => !value || !Number.isFinite(new Date(value).getTime()) ? '未知' : new Date(value).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false }) + ' ET';
const state = { pack: null, selected: null, busy: false, saved: null, forward: null, provider: null, comparison: null, history: [], historyKey: '', draft: null, request: 0, controller: null, detailFresh: null };
let quotePullPending = false;
let lastQuotePull = 0;
let syncingHistory = false;
const setStatus = text => { $('optionStatus').textContent = text; };
const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const cell = value => `<td>${value}</td>`;
const currentModel = () => state.pack?.modelVersion === 'option-research-v3';
function stillFresh(row) {
  const now = Date.now(), times = row.sourceTimes || {}, legs = row.contract?.legs || [];
  return row.freshness?.fresh && times.quoteAt > now - 180000 && times.intraLastTs > now - 1800000 && legs.length && legs.every(l => l.quoteAt > now - 180000 && l.quoteAt <= now + 5000);
}
const eligible = row => row.eligible && stillFresh(row) && !state.pack?.historicalView;
const assess = row => assessment(row, { currentModel: currentModel(), fresh: stillFresh(row), eligible: eligible(row), historicalView: state.pack?.historicalView });
const typeName = type => type === 'call' ? 'Call' : type === 'put' ? 'Put' : '类型未知';
const legName = (leg, row) => `${row?.action && row.action !== 'NO_TRADE' ? (leg.side === 'sell' ? '卖' : '买') : '参考'} ${typeName(leg.type)} ${money(leg.strike)}`;
function contractSummary(row) {
  const { legs } = referenceContract(row);
  return legs.length ? legs.map(l => `<span>${esc(legName(l, row))}</span><small>到期 ${esc(l.expiration || '未知')}</small>`).join('<br>') : '未取得合约';
}
function quoteSummary(row) {
  const { legs } = referenceContract(row);
  return legs.length ? legs.map(l => `<span>${legs.length > 1 ? `${l.side === 'sell' ? '卖腿' : '买腿'} ${typeName(l.type)}<br>` : ''}${money(l.bid)} / ${money(l.ask)}</span>`).join('<br>') : '— / —';
}
function selectSymbol(symbol) {
  state.selected = symbol; renderRows(); renderDetail(); $('optionDetail').focus({ preventScroll: true });
}
function renderRecommendations() {
  if (state.pack?.historicalView) {
    const rows = state.pack.historicalBuys || [];
    $('optionRecommendations').innerHTML = `<h3>${esc(state.pack.date)} 当时的推荐买入 · ${rows.length} 个</h3><p>历史回看：${stamp(state.pack.generatedAt)} 保存的判断及报价，不是当前推荐。</p>${rows.length ? `<div class="option-recommendation-cards">${rows.map(r => `<article><button class="option-symbol" type="button" data-symbol="${esc(r.symbol)}">${esc(r.symbol)} · ${esc(actionLabel(r.originalAction || r.action))} ↗</button><p>${contractSummary(r)}</p><p>当时参考 Bid / Ask：${quoteSummary(r)}</p><p>${esc(r.reason)}</p></article>`).join('')}</div>` : '<p>这份扫描当时没有记录买入候选；下方仍可查看完整扫描。</p>'}`;
    $('optionRecommendations').querySelectorAll('[data-symbol]').forEach(b => b.addEventListener('click', () => selectSymbol(b.dataset.symbol)));
    return;
  }
  const rows = state.pack?.ideas || [], candidates = rows.filter(eligible).slice(0, 3);
  const kinds = rows.map(assess);
  const statusSummary = `历史记录 ${kinds.filter(r => r.kind === 'history').length} 个 · 数据待核实 ${kinds.filter(r => r.kind === 'data').length} 个 · 评估后暂无优势 ${kinds.filter(r => r.kind === 'no-edge').length} 个`;
  const historical = rows.filter(r => !eligible(r) && ['BUY_CALL','BUY_PUT','CALL_SPREAD','PUT_SPREAD','STRADDLE'].includes(r.originalAction));
  const missingBbo = currentModel() && rows.length && rows.every(r => {
    const legs = r.contract?.legs || [];
    return !legs.length || legs.some(l => !(l.quoteAt > 0));
  });
  $('optionRecommendations').innerHTML = `<h3>推荐买入候选 <span>${candidates.length} 个</span></h3><p class="muted">只读研究建议，不自动下单。报价、费用、样本和事件校验全部通过后，才进入这里。</p>${candidates.length ? `<div class="option-recommendation-cards">${candidates.map(r => `<article><button class="option-symbol" type="button" data-symbol="${esc(r.symbol)}">${esc(r.symbol)} · ${esc(actionLabel(r.action))} ↗</button><p>${contractSummary(r)}</p><p>参考 Bid / Ask（每股）：${quoteSummary(r)}</p><p>每组含费投入 ${money(r.costs?.entryCost)} · 最大损失 ${money(r.costs?.maxLoss)}</p><p>${esc(r.reason)}</p></article>`).join('')}</div>` : `<p><strong>${rows.length ? '当前暂无通过校验的买入候选。' : '尚未扫描，请点击“重新扫描”。'}</strong>${rows.length ? '数据未齐时尚未作出买入判断；下方保留参考价格与到期日。' : ''}</p><p>${esc(statusSummary)}</p>${missingBbo ? '<p>Yahoo / Nasdaq 期权链没有每腿 Bid/Ask 时间，买入候选无法核验。这不是把全部标的判成暂不买入。</p>' : ''}${!currentModel() && rows.length ? `<p>当前显示 ${esc(state.pack.date || '未知日期')} 的已保存旧扫描。手续费默认 $0，点“重新扫描”用新版合约校验；免费源仍可能缺买卖盘时间。</p>` : ''}${historical.length ? `<p>模型买入判断（当前未通过校验）：${historical.map(r => `${esc(r.symbol)} ${esc(actionLabel(r.originalAction))}`).join('、')}。</p>` : ''}`}`;
  $('optionRecommendations').querySelectorAll('[data-symbol]').forEach(b => b.addEventListener('click', () => selectSymbol(b.dataset.symbol)));
}
function lockButtons() {
  for (const id of ['optionRefreshBtn', 'optionStrategy', 'optionFee', 'optionHistory']) $(id).disabled = state.busy;
  $('optionWriteBtn').disabled = state.busy || !state.pack?.scanId || state.pack.cached || state.saved === state.pack.scanId;
  $('optionRefreshBtn').textContent = state.busy ? '处理中…' : '重新扫描';
}
async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function renderSummary() {
  const p = state.pack, rows = p?.ideas || [], count = p?.historicalView ? p.historicalBuys.length : rows.filter(eligible).length;
  const bad = rows.filter(row => !stillFresh(row));
  const reasons = [...new Set(bad.flatMap(r => r.blockers || []))].filter(s => /时间|过期|历史|观察日/.test(s));
  const refreshed = p?.quotesRefreshedAt ? `合约价格已于 ${stamp(p.quotesRefreshedAt)} 重取。` : '';
  $('optionFreshness').innerHTML = `<div class="option-alert ${bad.length || !rows.length ? 'is-stale' : ''}"><strong>${bad.length ? '非实时 / 已过期 · 不可据此操作' : !rows.length ? '尚无扫描数据' : '报价通过时效检查 · 仍为只读研究'}</strong><p>${esc(reasons.join('；') || (bad.length ? '来源报价已老化或缺少可验证时间。' : '候选仍须通过费用、合约、样本和事件校验。'))} ${esc(refreshed)}打开本页后约每分钟重取 Bid/Ask。买入候选仍要有每腿买卖盘时间。</p><p>观察日 ${esc(p?.date || '未知')} · 扫描生成 ${stamp(p?.generatedAt)} · 当前 ${stamp(Date.now())}${p?.quoteRefreshErrors?.length ? ` · 刷新失败 ${esc(p.quoteRefreshErrors.slice(0, 3).join('；'))}` : ''}</p></div>`;
  const vixText = p?.vix == null || p.vix === 'unknown' || !Number.isFinite(Number(p.vix)) ? '未知' : Number(p.vix).toFixed(2);
  $('optionSummary').innerHTML = `<div class="option-overview"><div><span>${p?.historicalView ? '当时的买入候选' : '推荐买入候选'}</span><strong>${count}</strong><small>${p?.historicalView ? '历史记录，不作为当前建议' : '最多 3 个，无合格项就不交易'}</small></div><div><span>扫描覆盖</span><strong>${rows.length} / ${p?.coverage?.total ?? '未知'}</strong><small>${p?.coverage ? `本轮上限 ${p.coverage.cap}；未扫描 ${p.coverage.unscanned.length}` : '旧扫描未记录全池规模'}</small></div><div><span>VIX</span><strong>${vixText}</strong><small>${vixText === '未知' ? '公开行情没有返回，不是 0' : (p?.vixSource || '公开行情')}</small></div><div><span>本次费用假设</span><strong>${money(p?.costAssumptions?.feePerContract)}</strong><small>每腿、每次；缺失则无净 EV</small></div></div>${p?.coverage?.unscanned?.length ? `<details><summary>本轮未覆盖的标的</summary><p>${esc(p.coverage.unscanned.join(' · '))}</p></details>` : ''}`;
}
function renderRows() {
  const search = $('optionSearch').value.trim().toUpperCase(), filter = $('optionFilter').value, sort = $('optionSort').value;
  const included = r => state.pack?.historicalView ? state.pack.historicalBuys.some(b => b.symbol === r.symbol) : eligible(r);
  const rows = (state.pack?.ideas || []).filter(r => `${r.symbol} ${r.name}`.toUpperCase().includes(search) && (filter === 'all' || (filter === 'eligible' ? included(r) : !included(r))));
  const risk = r => currentModel() && r.costs?.ok ? r.costs.maxLoss : null;
  const ratio = r => risk(r) > 0 && r.evEstimate?.perGroup != null ? r.evEstimate.perGroup / risk(r) : -Infinity;
  rows.sort((a, b) => sort === 'ev' ? ratio(b) - ratio(a) : sort === 'risk' ? (risk(a) ?? Infinity) - (risk(b) ?? Infinity) : Number(eligible(b)) - Number(eligible(a)) || ratio(b) - ratio(a));
  $('optionScanTable').innerHTML = rows.length ? table(['标的 / 参考股价', '合约 / 到期日', '参考 Bid / Ask<br>USD / 股', '建议 / 状态', '净 EV / 最大损失<br>USD / 组'], rows.map(r => `<tr class="${r.symbol === state.selected ? 'is-active' : ''}">${cell(`<button type="button" class="option-symbol" data-symbol="${esc(r.symbol)}" aria-pressed="${r.symbol === state.selected}">${esc(r.symbol)} ↗</button><small>股价 ${money(r.last)}</small><small>${esc(r.lean || '')}</small>`)}${cell(contractSummary(r))}${cell(`${quoteSummary(r)}<small>${stillFresh(r) ? '源报价，非成交保证' : '历史 / 时效未验证'}</small>`)}${cell(`<strong>${esc(assess(r).label)}</strong><small>${esc(assess(r).reason)}</small><small>${esc(r.horizon || '—')} · ${num(r.patternMatches)} 样本</small>`)}${cell(`${assess(r).evLabel || money(r.evEstimate?.perGroup)}<small>最大损失 ${money(risk(r))}</small>`)}</tr>`)) : '<p class="empty">没有符合筛选条件的标的。</p>';
  $('optionScanTable').querySelectorAll('[data-symbol]').forEach(button => button.addEventListener('click', () => selectSymbol(button.dataset.symbol)));
}
function renderDetail() {
  const r = state.pack?.ideas?.find(row => row.symbol === state.selected), el = $('optionDetail');
  state.detailFresh = r ? stillFresh(r) : null;
  if (!r) { el.innerHTML = '<p class="empty">选择左侧标的查看组合、时效与情景。</p>'; return; }
  const c = currentModel() ? r.costs : null, reference = referenceContract(r), legs = reference.legs, valid = c?.ok;
  const budget = $('optionBudget').value.trim() ? Number($('optionBudget').value) : null;
  const quantity = eligible(r) && budget > 0 && c?.maxLoss > 0 ? Math.floor(budget / c.maxLoss) : null;
  const metric = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  el.innerHTML = `<h3>${esc(r.symbol)} · ${esc(assess(r).label)}</h3><div class="option-contract-hero"><p><strong>参考股价 ${money(r.last)}</strong> · 观察日 ${esc(state.pack?.date || '未知')}</p><p>${contractSummary(r)}</p><p><strong>参考 Bid / Ask（USD / 股）</strong><br>${quoteSummary(r)}</p><small>${stillFresh(r) ? '源报价，非保证成交价' : '历史 / 时效未验证；保留来源价格供查看，不代表当前可成交价'}${reference.incomplete ? '；旧记录缺完整元数据，组合成本不重新推算' : ''}</small></div><p>${esc(assess(r).reason)}</p><details><summary>扫描时的模型说明（未通过校验时不作当前结论）</summary><p>${esc(r.reason)}</p></details><p class="option-blockers">${esc((r.blockers || []).join('；') || '已通过研究门槛；仍需人工核实')}</p>
    <details open><summary>来源日期与每腿报价</summary><p>报价源：${esc(r.source?.chain || '未知')}<br>标的报价：${stamp(r.sourceTimes?.quoteAt)}<br>最后完成的 5 分钟 K 线起点：${stamp(r.sourceTimes?.intraLastTs)}<br>抓取时间（非报价）：${stamp(r.sourceTimes?.fetchedAt)}</p>${legs.length ? legs.map(l => `<div class="option-leg"><strong>${l.side === 'sell' ? '卖腿' : '买腿'} · ${esc(l.type)} $${num(l.strike)} · ${esc(l.expiration)}</strong><small>${esc(l.contractSymbol || '未记录合约代码')}</small><p>Bid ${money(l.bid)} / Ask ${money(l.ask)} · 价差 ${l.bid > 0 && l.ask > 0 ? num((l.ask - l.bid) / ((l.bid + l.ask) / 2) * 100) + '%' : '未知'}<br>Bid/Ask 时间：${stamp(l.quoteAt)}<br>成交量 ${num(l.volume)} · OI ${num(l.openInterest)} · DTE ${num(l.dte)} · IV ${l.iv == null ? '—' : num(l.iv * 100) + '%'}<br>交割单位：${l.standard && l.multiplier === 100 ? (l.unitSource === 'listed-osi' ? '标准 100 股/张（按上市代码推断）' : '标准 100 股/张') : '未核实'}</p></div>`).join('') : '<p>历史记录缺完整组合腿，须重新扫描。</p>'}</details>
    <h4>每组成本与预算 · USD</h4><div class="option-metrics">${metric('入场借记（买 Ask / 卖 Bid）', valid ? money(c.debit) : '不可评估')}${metric('中间价参考（非成交）', valid ? money(c.midCost) : '—')}${metric('入场含费投入', valid ? money(c.entryCost) : '—')}${metric('最大损失（预留双程费用）', valid ? money(c.maxLoss) : '—')}${metric('最大收益（含费）', !valid ? '—' : c.uncapped ? '理论无上限' : money(c.maxProfit))}${metric('预算上限（组）', quantity == null ? '不可评估' : String(quantity))}</div>
    <p class="muted">每组每腿 1 张。没有预算、费用或合格报价时不计算数量。行情变化、跳空或提前行权可能使执行不同于模型。</p>
    ${valid ? `<p>到期盈亏平衡点：${c.breakevens.map(money).join(' / ')} ${c.roundTripFees == null ? '（未含费）' : '（含双程费）'}<br>组合价格观察线：止损 ${money(c.stopPlan)} · 第一止盈 ${money(c.takeProfit1)} · 第二止盈 ${money(c.takeProfit2)}。仅观察线，不保证止损成交。</p>` : `<p>${esc(currentModel() ? c?.issues?.join('；') || '缺完整数据，暂未计算' : '旧扫描未按新版组合成本及费用计算，净 EV 与最大损失需重扫后重新评估')}</p>`}
    <details open><summary>同标的方案比较 · 含“不交易”</summary>${table(['结构', '投入含费', '最大损失', '净 EV / 组'], (currentModel() ? r.alternatives || [] : []).map(a => `<tr>${cell(esc(a.action))}${cell(a.costs?.ok ? money(a.costs.entryCost) : '不可评估')}${cell(a.costs?.ok ? money(a.costs.maxLoss) : '—')}${cell(money(a.ev?.perGroup))}</tr>`).concat(`<tr>${cell('不交易')}${cell('$0.00')}${cell('$0.00')}${cell('$0.00')}</tr>`))}<p class="muted">各结构均须独立通过每腿时效及事件校验；模型 EV 不直接代表交易结论。</p></details>
    <details><summary>盈亏情景 · 股价 / 时间 / IV</summary><p>股价变动 −5%、0%、+5%、+10%；IV ±20 个百分点。欧式模型变化锚定当前中间价，扣价差及双程费；无股息、提前行权模型，非成交价格。</p><div class="table-wrap">${table(['股价变化', '经过日历天', 'IV 变化', '净损益 / 组'], (currentModel() ? r.scenarios || [] : []).map(s => `<tr>${cell(s.ok ? num(s.movePct) + '%' : '不可评估')}${cell(num(s.elapsedDays))}${cell(s.ivChange == null ? '—' : num(s.ivChange * 100) + 'pp')}${cell(s.ok ? money(s.netPnl) : esc(s.reason))}</tr>`))}</div></details>
    ${r.sourceDiagnostics?.length ? `<details><summary>本标的数据来源与缺口</summary>${r.sourceDiagnostics.map(d=>`<p><strong>${esc(d.label)}</strong>：${esc(d.reason)}<br>${esc(d.nextStep)}</p>`).join('')}</details>` : ''}
    <p class="muted">${!r.scenarios?.length ? '情景不可评估：缺完整合约、模型参数或有效观察视界。' : ''}${esc((r.notes || []).join('；'))}</p>`;
}
function renderSources() {
  const rows = state.pack?.ideas || [], diagnostics = rows.flatMap(r => (r.sourceDiagnostics || []).map(d => ({ ...d, symbol: r.symbol })));
  $('optionSources').innerHTML = `<p>${esc(state.provider?.message || '正在读取行情源配置；不会用抓取时间补报价时间。')}</p><p>本次报价源：${esc([...new Set(rows.map(r => r.source?.chain).filter(Boolean))].join(' / ') || '尚无记录')}。来源配置不代表本次请求成功，仍需查看每项字段。</p>${diagnostics.length ? table(['字段', '本次覆盖', '缺口与下一步'], ['underlying','optionQuotes','earnings','units'].map(key => {
    const fields=diagnostics.filter(d=>d.key===key), ready=fields.filter(d=>['available','not-applicable'].includes(d.status)).length, incomplete=fields.filter(d=>!['available','not-applicable'].includes(d.status));
    return `<tr>${cell(esc(fields[0]?.label))}${cell(`${ready}/${fields.length} 字段可用`)}${cell(esc(incomplete.length ? `${incomplete.slice(0,5).map(d=>d.symbol).join('、')} 等：${incomplete[0].reason}。${incomplete[0].nextStep}` : '字段有来源；逐腿时效仍单独校验'))}</tr>`;
  })) : '<p>这份历史扫描未记录逐项来源诊断。重新扫描后显示；原始历史不会改写。</p>'}${rows.some(r=>r.providerError) ? `<p class="option-blockers">已配置来源本次未成功，使用参考备用源：${esc(rows.find(r=>r.providerError).providerError)}</p>` : ''}`;
}
function renderCollector() {
  const c=state.forward?.collector;
  if (!c) { $('optionCollectorStatus').textContent='后台采集状态未知'; $('optionCollectorBtn').disabled=true; return; }
  $('optionCollectorBtn').disabled=false; $('optionCollectorBtn').textContent=c.enabled?'暂停自动采集':'启用自动采集';
  $('optionCollectorStatus').innerHTML=`<p><strong>${c.enabled?(c.running?'自动采集中':'自动采集已启用'):'自动采集已暂停'}</strong> · ${c.intervalMs/1000} 秒检查一次 · 下个待观察目标 ${stamp(state.forward.nextTargetAt)}</p><p>本次服务最近完成 ${stamp(c.lastCompletedAt)} · 下一轮 ${stamp(c.nextRunAt)}。只处理已保存的待观察记录；Docker 停机期间不运行。</p>${c.lastError?`<p class="option-blockers">${esc(c.lastError)}</p>`:''}`;
}
function renderComparison() {
  const c=state.comparison;
  if (!c) { $('optionComparison').innerHTML='<p>本次扫描尚未保存，没有前向跟踪基线。保存后才建立记录；旧扫描不会补造报价。</p>'; return; }
  const labels={locked:'已采集有效结果',pending:'等待固定退出时刻',missing:'报价窗口缺失',excluded:'基线未通过校验','no-baseline':'无可验证报价基线',incompatible:'版本或合约不匹配'};
  $('optionComparison').innerHTML=`<p>观察日 ${esc(c.date)} · 原推荐 ${c.counts.recommended} 个 · 已有有效结果 ${c.counts.locked} 个 · 待观察 ${c.counts.pending} 个 · 无有效结果 ${c.counts.unavailable} 个</p><p class="muted">${esc(c.note)}</p>${c.candidates.length?table(['原始推荐 / 合约','固定退出目标','入场成本 / 费用','后续报价损益','状态 / 依据'],c.candidates.map(r=>`<tr>${cell(`<strong>${esc(r.symbol)} · ${esc(actionLabel(r.action))}</strong><small>${contractSummary(r)}</small>`)}${cell(`${esc(r.horizon||'未知')}<small>${stamp(r.targetAt)}</small>`)}${cell(`${money(r.entryCost)} / 组<small>费用 ${money(r.feePerContract)} / 腿 / 次</small>`)}${cell(r.netPnl==null?'未验证':`${money(r.netPnl)}<small>投入回报 ${num(r.returnPct)}% · 退出价值 ${money(r.exitValue)}</small><small>${stamp(r.exitAt)}</small>`)}${cell(`<strong>${esc(labels[r.status]||r.status)}</strong><small>${esc(r.reason)}</small><small>采集尝试 ${r.attempts} 次</small>`)}</tr>`)):'<p>这份扫描当时没有买入推荐，因此没有推荐合约收益可以结算。</p>'}${c.errors?.length?`<p class="option-blockers">${esc(c.errors.join('；'))}</p>`:''}`;
}
async function loadComparison() {
  if (!state.pack || (!state.pack.cached && state.saved !== state.pack.scanId)) { state.comparison=null; renderComparison(); return; }
  const p=state.pack, key=p.historyKey || state.history.find(h=>p.scanId?h.scanId===p.scanId:h.date===p.date)?.key;
  if (!key) { state.comparison=null; renderComparison(); return; }
  try { const data=await request(`/api/options/comparison?${new URLSearchParams({key,strategy:p.strategy?.id||'cov'})}`); if(state.pack===p) {state.comparison=data;renderComparison();} }
  catch(error) { if(state.pack===p) $('optionComparison').textContent=`结果对照暂不可用：${error.message}`; }
}
function viewingLiveScan() {
  return state.pack && !state.pack.historicalView && (!state.historyKey || state.historyKey === '__draft');
}
async function refreshLiveQuotes() {
  if (quotePullPending || !viewingLiveScan() || $('panel-options').hidden) return;
  if (state.historyKey === '__draft') return;
  quotePullPending = true;
  lastQuotePull = Date.now();
  const scanId = state.pack.scanId;
  try {
    const data = await request(`/api/options?quotes=1&strategy=${encodeURIComponent($('optionStrategy').value || 'cov')}`);
    if (!viewingLiveScan() || state.pack?.scanId !== scanId) return;
    if (data.scanId && scanId && data.scanId !== scanId) return;
    const selected = state.selected;
    state.pack = {
      ...state.pack,
      ideas: data.ideas,
      buys: data.buys,
      tempting: data.tempting,
      skipped: data.skipped,
      counts: data.counts,
      quotesRefreshedAt: data.quotesRefreshedAt,
      quoteRefreshErrors: data.quoteRefreshErrors,
      liveQuotes: true
    };
    state.selected = selected;
    render();
  } catch (error) {
    if (!$('panel-options').hidden) setStatus(`合约价格刷新失败：${error.message}。屏幕上仍是上一份价格。`);
  } finally {
    quotePullPending = false;
  }
}
let observationReadPending = false;
async function refreshObservationRead() {
  if (observationReadPending) return;
  observationReadPending = true;
  const p=state.pack;
  try { const f=await request('/api/options/forward'); if(state.pack!==p)return;state.forward=f;renderForward();renderCollector();await loadComparison(); }
  catch(error) { $('optionCollectorStatus').textContent=`状态读取失败：${error.message}；此前展示可能已过期`; }
  finally { observationReadPending = false; }
}
function renderScore() {
  const s = state.pack?.score, all = s?.locked?.all;
  $('optionScore').innerHTML = `<p>次日股票方向：${all?.n ? `${all.hits}/${all.n} 对（${num(all.rate)}%）` : '无已结算样本'} · 最近统计 ${stamp(s?.updatedAt)}</p><p>仅方向辅助；不含期权权利金、IV、费用或原模型视界。旧统计尚未重算前不作为新模型证据。</p>${table(['观察日', '结算日', '标的', '结果'], (s?.recent || []).slice(0, 16).map(r => `<tr>${cell(esc(r.callDate))}${cell(esc(r.settleDate || '待结算'))}${cell(esc(r.symbol))}${cell(r.status !== 'locked' ? '待结算' : r.hit ? '方向正确' : '方向未中')}</tr>`))}`;
}
function renderForward() {
  const f = state.forward;
  $('optionForward').innerHTML = !f ? '<p>复盘尚未读取。</p>' : `<p>${esc(f.note)}</p>${table(['观察视界', '有效合约样本', '盈利样本', '含费报价损益合计'], (f.groups || []).map(g => `<tr>${cell(esc(g.horizon))}${cell(g.n)}${cell(g.n ? `${g.wins}/${g.n}` : '未验证')}${cell(money(g.netPnl))}</tr>`))}<p>待观察 ${f.pending} · 报价窗口缺失 ${f.missing} · 无法建立样本 ${f.excluded}。均为假设报价进出，不是实际成交收益。</p><details><summary>记录及缺样本原因</summary>${(f.records || []).map(r => `<p>${esc(r.symbol)} · ${esc(r.horizon)} · 目标 ${stamp(r.targetAt)} · ${esc(r.status)}<br>${esc(r.reason)}</p>`).join('') || '<p>保存新扫描后建立前向记录；历史缺报价的扫描不会生成虚假样本。</p>'}</details>`;
}
function renderHistory() {
  syncingHistory = true;
  try {
    $('optionHistory').innerHTML = `<option value="">最新已保存扫描</option>${state.draft && state.saved !== state.draft.scanId ? '<option value="__draft">本次未保存扫描</option>' : ''}` + state.history.map(h => `<option value="${esc(h.key)}">${esc(h.date)} · ${h.generatedAt ? esc(stamp(h.generatedAt)) : '生成时间未知'} · 当时 ${h.originalBuyCount} 个候选</option>`).join('');
    $('optionHistory').value = state.historyKey;
    if (state.historyKey && $('optionHistory').value !== state.historyKey) $('optionHistory').value = '';
    $('optionHistoryStatus').textContent = `已保存 ${state.history.length} 份扫描 · 同日不同版本分别保留 · 未保存扫描只在本次页面会话保留`;
  } finally { syncingHistory = false; }
}
async function loadHistory() {
  try { const data = await request(`/api/options/history?strategy=${encodeURIComponent($('optionStrategy').value || 'cov')}`); state.history = data.history || []; renderHistory(); }
  catch (error) { $('optionHistoryStatus').textContent = `历史列表读取失败：${error.message}`; }
}
function render() { renderSummary(); renderRecommendations(); renderRows(); renderDetail(); renderSources(); renderScore(); lockButtons(); }
export async function loadOptionStrategies() {
  const data = await request('/api/options/strategies');
  $('optionStrategy').innerHTML = (data.strategies || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  return data.strategies;
}
export async function loadOptions({ refresh = false, write = false, historyKey = '' } = {}) {
  if (state.busy) {
    if (refresh) setStatus('上一轮扫描还在进行。按钮显示「处理中」时请等它结束，不要重复点。');
    return;
  }
  state.busy = true; lockButtons(); const id = ++state.request;
  state.controller?.abort(); state.controller = new AbortController();
  setStatus(write ? '正在保存屏幕上这一次扫描，不重新扫描…' : refresh ? '正在获取行情并校验合约，可能需要几十秒…' : '正在读取已保存扫描…');
  try {
    if (write) {
      const result = await request('/api/options/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanId: state.pack?.scanId }), signal: state.controller.signal });
      state.saved = result.scanId; state.historyKey = ''; setStatus('已保存本次扫描快照；没有下单，也没有改写操作记录。');
    } else {
      const query = new URLSearchParams({ strategy: $('optionStrategy').value || 'cov' });
      if (refresh) {
        query.set('refresh', '1');
        query.set('fee', $('optionFee').value.trim() === '' ? '0' : $('optionFee').value);
        query.set('_', String(Date.now()));
      }
      const data = historyKey === '__draft' && state.draft ? state.draft : await request(historyKey && !refresh ? `/api/options/history?${query}&key=${encodeURIComponent(historyKey)}` : `/api/options?${query}`, { signal: state.controller.signal });
      if (id !== state.request) return;
      state.pack = data; state.historyKey = refresh ? '__draft' : historyKey;
      if (refresh) { state.draft = data; state.saved = null; }
      state.selected = data.historicalBuys?.[0]?.symbol || data.buys?.[0]?.symbol || data.ideas?.[0]?.symbol || null;
      if (!refresh) $('optionFee').value = data.costAssumptions?.feePerContract ?? 0;
      render();
      setWheelCandidates(data.wheelCandidates || []);
      loadWheel().catch(() => {});
      if (!refresh && !historyKey && !data.historicalView) refreshLiveQuotes();
      setStatus(data.historicalView
        ? '正在回看已保存历史扫描。原始推荐与价格保留，不是当前操作建议。'
        : data.cached
          ? '显示已保存历史快照；时效已按当前时间重新校验。点击重新扫描获取新结果。'
          : `扫描完成 ${stamp(data.generatedAt)}。这是刚扫的结果，还没覆盖已保存文件；要留下来请点保存。`);
    }
    await loadHistory();
    try { state.provider=(await request('/api/options/sources')).provider;renderSources(); } catch { state.provider=null;renderSources(); }
    try { state.forward = await request('/api/options/forward'); renderForward(); renderCollector(); await loadComparison(); } catch (error) { $('optionForward').textContent = `复盘读取失败：${error.message}`; }
  } catch (error) { if (error.name !== 'AbortError') setStatus(`操作失败：${error.message}。已保留上次结果。`); }
  finally { if (id === state.request) { state.busy = false; lockButtons(); renderHistory(); } }
}
export function bindOptionsUi() {
  $('optionRefreshBtn').addEventListener('click', () => loadOptions({ refresh: true }));
  $('optionWriteBtn').addEventListener('click', () => loadOptions({ write: true }));
  $('optionStrategy').addEventListener('change', () => { state.draft = null; loadOptions(); });
  $('optionHistory').addEventListener('change', () => {
    if (syncingHistory) return;
    const key = $('optionHistory').value;
    if (key === state.historyKey) return;
    loadOptions({ historyKey: key });
  });
  for (const id of ['optionSearch', 'optionFilter', 'optionSort']) $(id).addEventListener('input', renderRows);
  $('optionBudget').addEventListener('input', renderDetail);
  $('optionFee').addEventListener('input', () => setStatus('手续费已修改；重新扫描后才应用。当前结果仍使用原扫描费用。'));
  $('optionCollectorBtn').addEventListener('click', async () => {
    $('optionCollectorBtn').disabled=true;
    try { await request('/api/options/collector',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!state.forward?.collector?.enabled})}); await refreshObservationRead(); }
    catch(error) { setStatus(`采集设置失败：${error.message}`); }
    finally { $('optionCollectorBtn').disabled=false; }
  });
  $('optionForwardBtn').addEventListener('click', async () => {
    $('optionForwardBtn').disabled = true;
    try { state.forward = await request('/api/options/forward', { method: 'POST' }); renderForward(); renderCollector(); await loadComparison(); }
    catch (error) { setStatus(`合约复盘刷新失败：${error.message}`); }
    finally { $('optionForwardBtn').disabled = false; }
  });
  setInterval(() => {
    if (!state.pack || $('panel-options').hidden) return;
    if (!state.busy) refreshObservationRead();
    if (!state.busy && Date.now() - lastQuotePull >= 60000) refreshLiveQuotes();
    renderSummary();
    renderRecommendations();
    const focusedSymbol = document.activeElement?.dataset?.symbol;
    renderRows();
    if (focusedSymbol) $('optionScanTable').querySelectorAll('[data-symbol]').forEach(b => { if (b.dataset.symbol === focusedSymbol) b.focus({ preventScroll: true }); });
    const selected = state.pack.ideas?.find(r => r.symbol === state.selected);
    const freshNow = selected ? stillFresh(selected) : null;
    if (freshNow !== state.detailFresh) renderDetail();
  }, 30000);
}
