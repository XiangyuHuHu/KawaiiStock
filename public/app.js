import { ensureScreenerLoaded } from './screener.js';
import { loadPosters, runPosters } from './poster.js';
import { bindOptionsUi, loadOptionStrategies, loadOptions } from './options.js';
import { bindOracleUi, loadOracle } from './oracle.js';
import { bindPaperUi, loadPaper } from './paper.js';
import { bindWatchUi, loadWatchlist } from './watchlist.js';
import { bindBriefUi, loadBrief } from './brief.js';
import { bindOpsUi, loadEvents, loadGuards, loadReview, renderOverviewEvents } from './ops.js';
import { rateText, stageRateOf, stageStripHtml, strategyLine } from './strategy-rate.js';

const money2 = (value, fallback = '—') => {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
};
const money = money2;

const pct = (value, digits = 1) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
};

const fmtTime = (date, timeZone) => new Intl.DateTimeFormat('en-GB', {
  timeZone, hour: '2-digit', minute: '2-digit', hour12: false
}).format(date);

function signedClass(value) {
  if (value == null) return '';
  if (value > 0) return 'pos';
  if (value < 0) return 'neg';
  return '';
}

function sparkSvg(points = []) {
  const nums = points.filter((n) => Number.isFinite(n));
  if (nums.length < 2) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const d = nums.map((n, i) => {
    const x = (i / (nums.length - 1)) * 100;
    const y = 26 - ((n - min) / span) * 22;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const up = nums.at(-1) >= nums[0];
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${up ? '#1f7a4d' : '#a33b32'}" stroke-width="1.6"/></svg>`;
}

function setActiveTab(id) {
  document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === id));
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.id === `panel-${id}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (state.desk && id !== 'sim' && id !== 'compare' && id !== 'actuals' && id !== 'options' && id !== 'paper' && id !== 'guards' && id !== 'review' && id !== 'oracle') {
    renderOverview(state.desk);
  }
}

const state = {
  deskId: localStorage.getItem('kawaii-desk') || 'grok',
  accountId: localStorage.getItem('kawaii-account') || 'main',
  compareAccountId: localStorage.getItem('kawaii-compare-account') || 'main',
  simAccountId: localStorage.getItem('kawaii-sim-account') || 'all',
  desk: null,
  quotes: {},
  draftRows: [],
  compare: null,
  sim: null,
  actuals: [],
  events: null,
  tradable: null,
  tradableKey: null
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function recStrategy(row, score) {
  if (!row) return '—';
  if (row.strategy?.stageLabel || row.strategy?.stage) return strategyLine(row, score);
  if (row.strategyLabel) {
    const cleaned = String(row.strategyLabel).replace(/\s*·\s*胜率.+$/, '');
    return `${cleaned} · ${rateText(stageRateOf(score, row.strategy?.stage))}`;
  }
  return '—';
}

function currentAccount() {
  return state.desk?.account;
}

function isWritable() {
  return Boolean(state.desk?.desk?.writable);
}

function renderDeskBar(desks = []) {
  const bar = document.getElementById('deskBar');
  bar.innerHTML = desks.map((row) => (
    `<button type="button" class="desk-chip ${row.id === state.deskId ? 'is-active' : ''}" data-id="${row.id}">
      <strong>${row.label}</strong>
      <small>${row.kicker}</small>
    </button>`
  )).join('')
    + `<button type="button" class="desk-chip is-link" data-tab="compare"><strong>对比</strong><small>规则 + 持仓</small></button>`
    + `<button type="button" class="desk-chip is-link" data-tab="sim"><strong>模拟操作</strong><small>纸上跟单</small></button>`
    + `<button type="button" class="desk-chip is-link" data-tab="paper"><strong>纸上实验</strong><small>Phase 0</small></button>`
    + `<button type="button" class="desk-chip is-link" data-tab="actuals"><strong>实际操作</strong><small>手改 / 成交</small></button>`;
  bar.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.deskId = btn.dataset.id;
      localStorage.setItem('kawaii-desk', state.deskId);
      document.body.dataset.desk = state.deskId;
      setActiveTab('overview');
      loadAccount(state.accountId);
    });
  });
  bar.querySelector('[data-tab="compare"]')?.addEventListener('click', () => {
    setActiveTab('compare');
    loadCompare();
  });
  bar.querySelector('[data-tab="sim"]')?.addEventListener('click', () => {
    setActiveTab('sim');
    loadSim();
  });
  bar.querySelector('[data-tab="paper"]')?.addEventListener('click', () => {
    setActiveTab('paper');
    loadPaper().catch((error) => {
      const status = document.getElementById('paperStatus');
      if (status) status.textContent = `纸上实验载入失败：${error.message}`;
    });
  });
  bar.querySelector('[data-tab="actuals"]')?.addEventListener('click', () => {
    setActiveTab('actuals');
    loadActuals();
  });
}

function renderAccountBar(config) {
  document.getElementById('accountBar').innerHTML = config.accounts.map((row) => (
    `<button type="button" class="account-chip ${row.id === state.accountId ? 'is-active' : ''}" data-id="${row.id}">${row.short}<small>${config.desk?.writable === false ? '对照' : (row.source === 'manual' ? '手改' : '扫描')}</small></button>`
  )).join('');
  document.querySelectorAll('#accountBar .account-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.accountId = btn.dataset.id;
      localStorage.setItem('kawaii-account', state.accountId);
      loadAccount(state.accountId);
    });
  });
}

function renderOverview(desk) {
  const account = desk.account;
  const rec = desk.accountRec;
  const holdings = desk.holdings || {};
  const writable = Boolean(desk.desk?.writable);
  document.body.dataset.desk = desk.desk?.id || 'grok';
  document.getElementById('brandKicker').textContent = `${desk.desk?.label || 'Grok'} · ${desk.desk?.kicker || '执行台'}`;
  document.getElementById('brandTitle').textContent = account.label;
  document.getElementById('brandSub').textContent = `${desk.desk?.subtitle || account.subtitle} · ${account.subtitle}`;
  document.getElementById('reportDate').textContent = desk.latestRec?.date || holdings.asOf || '—';
  const stance = rec?.priorities?.[0]?.action || (writable ? 'WAIT' : 'READ');
  document.getElementById('stancePill').textContent = stance;
  document.getElementById('headline').textContent = rec?.priorities?.[0]?.title
    || (writable ? '尚无今日推荐操作。点「推荐操作」生成。' : (desk.updates?.reason || '尚无 ChatGPT 推荐文件；缺失不等于 HOLD。'));
  document.getElementById('statusLine').textContent = holdings.stale
    ? (holdings.staleLabel || holdings.note || `缺数据：这不是实时持仓。上次 ${holdings.asOf || '未知'}。`)
    : (holdings.staleLabel || holdings.note || `${desk.desk?.label} · ${account.label} · 来源 ${account.source} · 持仓 ${(holdings.positions || []).length}`);
  document.getElementById('generatedAt').textContent = `生成 ${new Date(desk.generatedAt).toLocaleString('zh-CN')}`;
  document.getElementById('colophonText').textContent = writable
    ? '每日流水：真实持仓 → 推荐操作 → 模拟操作 → 实际操作。今日买卖是独立草稿。默认不下单。'
    : 'ChatGPT 对照手册只读。推荐操作在 推荐操作/；不覆盖手册正文、不下单。';

  document.getElementById('summaryStrip').innerHTML = [
    [holdings.totalValue != null || holdings.equity != null ? '账户总值' : '持仓成本（非净值）', money2(holdings.totalValue ?? holdings.equity ?? holdings.costTotal)],
    ['现金', money2(holdings.cash)],
    ['持仓数', holdings.positions?.length ?? 0],
    ['台', desk.desk?.label || 'Grok'],
    ['持仓快照', holdings.staleLabel || (holdings.asOf ? String(holdings.asOf).slice(0, 10) : '未知')]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join('');

  const actions = rec?.priorities?.length
    ? rec.priorities
    : writable
      ? [{ action: 'WAIT', title: '等待推荐操作', detail: '先生成或等待每日任务。' }]
      : [
          ...(rec?.recommendations?.length ? rec.recommendations.slice(0,3) : [{action:'缺数据',title:desk.updates?.reason || '本账户尚无逐股建议'}])
        ];
  document.getElementById('actionList').innerHTML = actions.map((item) => {
    const rec = desk.accountRec?.recommendations?.find((row) => row.symbol && row.symbol === item.symbol)
      || desk.accountRec?.opportunities?.find((row) => row.symbol && row.symbol === item.symbol)
      || item;
    const line = recStrategy({ ...rec, strategyLabel: item.strategyLabel || rec.strategyLabel }, desk.watchScore);
    return `
    <li>
      <span class="action-tag ${item.action}">${item.action}</span>
      <div>
        <strong>${item.symbol ? item.symbol + ' · ' : ''}${item.title}</strong>
        <small class="strategy-line">判断：${line}</small>
      </div>
    </li>
  `;
  }).join('');

  const risk = account.risk || {};
  document.getElementById('riskDl').innerHTML = Object.entries({
    '目标持仓数': risk.targetNames,
    '单笔/单标上限': risk.limitLabel
      || (risk.maxSinglePct ? `${risk.maxSinglePct}%` : risk.maxLossPct ? `${risk.maxLossPct}% 止损` : risk.coreMaxPct ? `${risk.coreMaxPct}%` : '—'),
    '现金': risk.cashTarget || (risk.cashFloorPct ? `底线 ${risk.cashFloorPct}%` : '—'),
    '持有期': risk.horizon
  }).map(([k, v]) => `<dt>${k}</dt><dd>${v || '—'}</dd>`).join('');

  if (account.id === 'agentic' && writable) {
    fetch('/api/risk?book=live').then((r) => r.json()).then((gate) => {
      const extra = {
        'Gateway': `${gate.mode === 'NOT_CONFIGURED' ? '未配置' : (gate.mode || (gate.kill ? 'KILL' : 'NORMAL'))}${gate.modeReason ? ` · ${gate.modeReason}` : ''}`,
        '单笔亏损': gate.capsComputable === false
          ? '净值未知，上限不可计算'
          : (gate.caps?.maxOrderRisk != null ? `$${Number(gate.caps.maxOrderRisk).toFixed(0)}（3%净值）` : '3%净值'),
        '单标 / 主题': gate.capsComputable === false
          ? '未配置'
          : (gate.caps?.maxSingleRisk != null
          ? `$${Number(gate.caps.maxSingleRisk).toFixed(0)} / $${Number(gate.caps.maxThemeRisk || 0).toFixed(0)}`
          : '8% / 15%'),
        '日亏 / 周亏': gate.capsComputable === false
          ? '未配置'
          : (gate.caps?.maxDailyLoss != null
          ? `上限 $${Number(gate.caps.maxDailyLoss).toFixed(0)} / $${Number(gate.caps.maxWeeklyLoss || 0).toFixed(0)}`
          : '6% / 8%'),
        '已实现日/周': `${money2(gate.book?.realizedPnlToday)} / ${money2(gate.book?.realizedPnlWeek)}`
      };
      document.getElementById('riskDl').insertAdjacentHTML(
        'beforeend',
        Object.entries(extra).map(([k, v]) => `<dt>${k}</dt><dd>${v || '—'}</dd>`).join('')
      );
    }).catch(() => {});
  }

  if (account.id === 'tactical' || account.id === 'agentic') {
    const pack = state.events;
    if (pack) renderOverviewEvents(pack, account.id);
    else {
      loadEvents().then((events) => {
        state.events = events;
        renderOverviewEvents(events, account.id);
      }).catch(() => {
        const el = document.getElementById('eventStrip');
        if (el) { el.hidden = true; el.innerHTML = ''; }
      });
    }
  } else {
    const el = document.getElementById('eventStrip');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }
}

function ideaKey(row) {
  return `${row.accountId}:${row.symbol}:${row.side}`;
}

function showTradableAnalysis(key) {
  const pack = state.tradable;
  const ideas = pack?.ideas || [];
  const idea = ideas.find((row) => ideaKey(row) === key) || ideas[0];
  if (!idea) return;
  state.tradableKey = ideaKey(idea);
  document.querySelectorAll('.tradable-row').forEach((tr) => {
    tr.classList.toggle('is-active', tr.dataset.key === state.tradableKey);
  });
  const html = idea.analysisHtml || `<p class="poster-empty">${idea.analysisError || '这只没有日线详细分析。'}</p>`;
  const overview = document.getElementById('tradableFrame');
  if (overview) overview.innerHTML = html;
}

function renderTradableTable(pack, tableId, statusId) {
  const table = document.getElementById(tableId);
  const status = document.getElementById(statusId);
  if (!table) return;
  const ideas = pack?.ideas || [];
  if (status) {
    status.textContent = pack?.error
      ? `今日买卖失败：${pack.error}`
      : ideas.length
        ? `${pack.date} 草稿 ${ideas.length} 条：卖 ${pack.counts?.sell ?? 0} · 减 ${pack.counts?.trim ?? 0} · 买 ${pack.counts?.buy ?? 0}。点一行看详细分析。不是下单。`
        : `${pack?.date || '今日'} 没有必须执行的买卖。主账户不为每天有动作而交易。`;
  }
  if (!ideas.length) {
    table.innerHTML = '<p class="empty">今日没有必须执行的买卖。</p>';
    return;
  }
  table.innerHTML = `<table>
    <thead><tr>
      <th>账户</th><th>代码</th><th>方向</th><th class="num">数量</th><th class="num">价格</th><th class="num">现价</th><th class="num">失效</th><th>理由</th><th></th>
    </tr></thead>
    <tbody>${ideas.map((row) => `
      <tr class="tradable-row${ideaKey(row) === state.tradableKey ? ' is-active' : ''}" data-key="${ideaKey(row)}">
        <td>${row.accountLabel || row.accountId}</td>
        <td class="sym-cell">${row.symbol}</td>
        <td><span class="action-tag ${row.side}">${row.side}</span></td>
        <td class="num">${row.qty}</td>
        <td class="num">${money2(row.price)}</td>
        <td class="num">${money2(row.last)}</td>
        <td class="num">${money2(row.failPrice)}</td>
        <td class="tradable-reason">${row.reason || ''}</td>
        <td><button type="button" class="text-btn" data-open-symbol="${row.symbol}">详情</button></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
  table.querySelectorAll('.tradable-row').forEach((tr) => {
    tr.addEventListener('click', () => showTradableAnalysis(tr.dataset.key));
  });
  bindOpenSymbols(table);
}

async function loadTradable({ write = false } = {}) {
  const overviewStatus = document.getElementById('tradableStatus');
  const message = write ? '正在写入今日买卖文件夹。' : '正在按持仓、推荐和价位图算可买卖草稿。';
  if (overviewStatus) overviewStatus.textContent = message;
  const url = write ? '/api/tradable/run' : '/api/tradable';
  const data = await fetch(url, { method: write ? 'POST' : 'GET' }).then((r) => r.json());
  state.tradable = data;
  if (!state.tradableKey && data.ideas?.[0]) state.tradableKey = ideaKey(data.ideas[0]);
  renderTradableTable(data, 'tradableTable', 'tradableStatus');
  showTradableAnalysis(state.tradableKey);
  if (write && !data.error && data.written) {
    const note = `已写入 ${data.written.date}，${data.written.count} 条。`;
    if (overviewStatus) overviewStatus.textContent = `${overviewStatus.textContent} ${note}`;
  }
  return data;
}

function bindOpenSymbols(root) {
  if (!root) return;
  root.querySelectorAll('[data-open-symbol]').forEach((el) => {
    if (el.dataset.boundOpen) return;
    el.dataset.boundOpen = '1';
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const symbol = el.dataset.openSymbol;
      if (!symbol) return;
      import('./screener.js').then(({ openSymbolDetail }) => openSymbolDetail(symbol));
    });
  });
}

function attachRecTickers(body) {
  if (!body) return;
  body.querySelectorAll('table tbody tr').forEach((tr) => {
    const cell = tr.querySelector('td');
    if (!cell || cell.dataset.openSymbol) return;
    const symbol = cell.textContent.trim().toUpperCase();
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) return;
    cell.dataset.openSymbol = symbol;
    cell.classList.add('sym-cell');
    cell.title = '打开估值 + 周期 + 价位图';
  });
  bindOpenSymbols(body);
}

function renderTape(quotes) {
  const symbols = [...new Set([
    ...(state.desk.holdings?.positions || []).map((row) => row.symbol),
    ...(state.desk.config.focusTape || [])
  ])].slice(0, 15);
  document.getElementById('focusTape').innerHTML = symbols.map((symbol) => {
    const q = quotes[symbol];
    if (!q?.ok) return `<div class="tape-card"><div class="sym">${symbol}</div><div class="px">—</div></div>`;
    return `<div class="tape-card"><div class="sym">${symbol}</div><div class="px ${signedClass(q.changePct)}">${q.last.toFixed(2)} <span>${pct(q.changePct)}</span></div>${sparkSvg(q.spark)}</div>`;
  }).join('');
}

function renderBookUpdates(desk) {
  const node=document.getElementById('bookUpdates'),u=desk.updates;
  node.hidden=!u;if(!u){node.innerHTML='';return;}
  const stateLabel=u.status==='available'?`已匹配 ${u.matched}/${u.positionCount} 项持仓建议`:'本账户未生成可用动作建议';
  const locations=[['推荐操作',u.outputs.recommendations],['模拟结算文件',u.outputs.simulation],['实际操作记录',u.outputs.actuals]];
  node.innerHTML=`<div class="option-alert"><strong>非实时${u.warnings.length?' / 数据未齐':''} · ${esc(stateLabel)}</strong><p>当前观察日（美东）${esc(u.observationDate)} · 持仓快照 ${esc(u.holdingsDate || '未知')} · 最新推荐 ${esc(u.recommendationDate || '缺失')}</p><p>${esc(u.reason)}</p>${u.warnings.length?`<ul>${u.warnings.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}<p>持仓档案与每日推荐独立更新；刷新页面不会改写持仓日期或生成缺失建议。</p><div class="head-actions"><button type="button" class="text-btn" data-read-updates>重新读取任务结果</button>${u.recommendationDate?`<button type="button" class="text-btn" data-open-rec="${esc(u.recommendationDate)}">查看 ${esc(u.recommendationDate)} 完整推荐</button>`:''}${u.status!=='available' && u.previousDate?`<button type="button" class="text-btn" data-open-rec="${esc(u.previousDate)}">历史参考：${esc(u.previousDate)} 本账户有建议</button>`:''}</div></div>
    <details class="oracle-method"><summary>每日任务更新到了哪里 · 查看三个账户与输出文件</summary><div class="table-wrap"><table><thead><tr><th>账户</th><th>最新文件中的逐股建议数</th><th>状态 / 原因</th></tr></thead><tbody>${u.accounts.map(a=>`<tr><td>${esc(a.label)}</td><td>${a.count}</td><td>${esc(a.reason || (a.status==='snapshot_partial'?'部分数据，需复核':a.status))}</td></tr>`).join('')}</tbody></table></div><p>持仓来源：<code>${esc(u.files.holdings)}</code></p>${locations.map(([title,x])=>`<p><strong>${title}：${esc(x.date||'尚无日期文件')}${x.date&&x.date<u.observationDate?' · 落后于观察日':''}</strong><br>${x.files.map(f=>`<code>${esc(f)}</code>`).join('<br>')||esc(x.directory)}</p>`).join('')}<p>上列是已有文件的日期，不是任务运行成功时间，也不代表发生实际成交。容器内 /chatgpt-recs、/chatgpt-sim、/chatgpt-actuals 分别对应 Obsidian 的 Chatgpt策略+记录/推荐操作、模拟操作、实际操作；/holdings 对应股票/持仓。</p></details>`;
  node.querySelectorAll('[data-open-rec]').forEach(button=>button.addEventListener('click',()=>{setActiveTab('recs');document.querySelector(`#recIndex [data-date="${button.dataset.openRec}"]`)?.click();}));
  node.querySelector('[data-read-updates]').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='正在重新读取…';
    try{await loadAccount(state.accountId);}catch(error){button.textContent=`读取失败：${error.message}`;button.disabled=false;}
  });
}

function renderBook(desk) {
  const account = desk.account;
  const holdings = desk.holdings || {};
  const rows = state.draftRows;
  document.getElementById('bookTitle').textContent = `${account.label}持仓`;
  const canImport = isWritable() && (account.source !== 'manual' || account.id === 'agentic');
  const handEdit = isWritable() && account.source === 'manual' && account.id !== 'agentic';
  document.getElementById('bookNote').textContent = !isWritable()
    ? 'ChatGPT 对照档案，只读。要改账本请切到 Grok 台。'
    : account.id === 'agentic'
      ? (holdings.staleLabel ? `${holdings.staleLabel}。导入只写研究快照，不下单。` : '可以导入 Robinhood 持仓 JSON。这是研究快照，不下单。')
      : account.source === 'manual'
        ? '无接口。改完点「保存主账户」，会同时写入 Obsidian 持仓档案。每日任务不会覆盖主账户。'
        : holdings.stale
          ? (holdings.staleLabel || holdings.note || '缺数据：这不是实时持仓。接口失败时不会把昨日档案改标成今日。')
          : '可以导入 Robinhood 持仓 JSON。这是研究快照，不是下单，也不是模拟操作。';
  document.getElementById('saveBookBtn').hidden = !handEdit;
  document.getElementById('addRowBtn').hidden = !handEdit;
  document.getElementById('scanSheet').hidden = !canImport;
  document.getElementById('runRecsBtn').hidden = !isWritable();
  const dailyBtn = document.getElementById('runDailyBtn');
  if (dailyBtn) dailyBtn.hidden = !isWritable();

  renderBookUpdates(desk);
  const canShow = !desk.updates || desk.updates.status === 'available';
  const recMap = Object.fromEntries((canShow ? desk.accountRec?.recommendations || [] : []).map((row) => [String(row.symbol).toUpperCase(), row]));
  const editable = isWritable() && account.source === 'manual' && account.id !== 'agentic';
  const staleBanner = !desk.updates && holdings.stale
    ? `<p class="stale-banner">${holdings.staleLabel || `缺数据：上次可靠扫描 ${holdings.asOf || '无'}。禁止把昨日持仓当成实时。`}</p>`
    : '';
  const body = rows.map((row, index) => `
    <tr>
      <td>${editable ? `<input data-i="${index}" data-k="symbol" value="${row.symbol || ''}">` : `<span class="sym-cell">${row.symbol || ''}</span>`}</td>
      <td>${editable ? `<input data-i="${index}" data-k="name" value="${row.name || ''}">` : (row.name || '')}</td>
      <td class="num">${editable ? `<input data-i="${index}" data-k="qty" value="${row.qty ?? ''}">` : (row.qty ?? '')}</td>
      <td>${editable ? `<input data-i="${index}" data-k="role" value="${row.role || ''}">` : (row.role || '')}</td>
      <td>${esc(recMap[row.symbol]?.action || (desk.updates ? '未生成建议' : '—'))}${recMap[row.symbol] && desk.updates ? `<small>推荐 ${esc(desk.updates.recommendationDate)}${desk.updates.recommendationDate < desk.updates.observationDate ? ' · 已过期' : ''}</small>` : ''}</td>
      <td>${esc(recStrategy(recMap[row.symbol], desk.watchScore))}</td>
      <td>${esc(recMap[row.symbol]?.title || (desk.updates ? desk.updates.status === 'available' ? '最新推荐未覆盖该持仓；不自动视为 HOLD。' : desk.updates.reason : ''))}</td>
      <td>${row.symbol ? `<button type="button" class="text-btn" data-open-symbol="${row.symbol}">详情</button>` : ''}</td>
    </tr>
  `).join('');
  const emptyBook = account.id === 'agentic'
    ? '<p class="empty">Agentic 持仓是空的。在下面导入 Robinhood 持仓 JSON。只记快照，不下单。</p>'
    : '<p class="empty">空仓。小账户等待扫描；主账户可手改增加。</p>';
  document.getElementById('positionTable').innerHTML = staleBanner + (rows.length ? `<table>
    <thead><tr><th>代码</th><th>名称</th><th class="num">数量</th><th>定位</th><th>动作</th><th>策略 / 胜率</th><th>理由</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>` : emptyBook);
  bindOpenSymbols(document.getElementById('positionTable'));

  document.querySelectorAll('#positionTable input').forEach((input) => {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.i);
      const key = input.dataset.k;
      state.draftRows[i][key] = key === 'qty' ? Number(input.value) : input.value;
    });
  });
}

function pxCell(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function recBookHtml(book, score) {
  const recRows = (book.recommendations || []).map((row) => `<tr>
    <td>${esc(row.symbol || '')}</td>
    <td>${esc(row.action || '')}</td>
    <td class="num">${row.qty ?? ''}</td>
    <td class="num">${pxCell(row.last)}</td>
    <td>${esc(recStrategy(row, score))}</td>
    <td>${esc(row.title || '')}</td>
    <td>${esc(row.detail || '')}</td>
  </tr>`).join('');
  const oppRows = (book.opportunities || []).map((row) => `<tr>
    <td>${esc(row.symbol || '')}</td>
    <td>${esc(row.action || '')}</td>
    <td>${esc(row.source || '')}</td>
    <td>${esc(recStrategy(row, score))}</td>
    <td>${esc(row.instrument || 'stock')}</td>
    <td class="num">${pxCell(row.failPrice)}</td>
    <td>${esc(row.maxLoss || '—')}</td>
    <td>${esc(row.title || '')}</td>
    <td>${esc(row.detail || '')}</td>
  </tr>`).join('');
  const top = (book.priorities || []).map((item, i) => (
    `<li><strong>${i + 1}. ${esc(item.action || '')} ${esc(item.symbol || '')}</strong> — ${esc(item.title || '')}<small class="strategy-line">判断：${esc(recStrategy(item, score))}</small></li>`
  )).join('');
  return `<section class="rec-book">
    <h2>${esc(book.label || book.id)}</h2>${book.reason ? `<p class="stale-banner">${esc(book.reason)}</p>` : ''}
    <p class="muted">来源：${esc(book.source || '')} · 持仓 ${book.positionCount ?? '—'} · asOf ${esc(book.asOf || '未知')}</p>
    <h3>优先动作</h3>
    <ol class="rec-priorities">${top || '<li>原文件未提供优先动作。</li>'}</ol>
    <h3>持仓处理</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>代码</th><th>动作</th><th class="num">数量</th><th class="num">现价</th><th>策略 / 胜率</th><th>结论</th><th>理由</th></tr></thead>
      <tbody>${recRows || '<tr><td colspan="7">无逐股建议数据；不能据此判断空仓或 HOLD。</td></tr>'}</tbody>
    </table></div>
    <h3>新机会</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>代码</th><th>动作</th><th>来源</th><th>策略 / 胜率</th><th>工具</th><th class="num">失效价</th><th>最大亏损</th><th>结论</th><th>理由</th></tr></thead>
      <tbody>${oppRows || '<tr><td colspan="9">无合格新机会</td></tr>'}</tbody>
    </table></div>
    ${Array.isArray(book.paperCandidates) ? `<h3>纸上实验候选</h3>
    <p class="muted">${esc(book.paperViewNote || '纸上实验独立视图，不是第二份推荐。与新机会重叠的代码只是同一排序的另一视角。')}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>代码</th><th>动作</th><th>视图</th><th>策略 / 胜率</th><th class="num">纸上止损</th><th>结论</th></tr></thead>
      <tbody>${book.paperCandidates.map((row) => `<tr>
        <td>${esc(row.symbol || '')}</td>
        <td>${esc(row.action || '')}</td>
        <td>${row.overlapsOpportunities ? '与新机会重叠' : '仅纸上视图'}</td>
        <td>${esc(recStrategy(row, score))}</td>
        <td class="num">${pxCell(row.failPrice)}</td>
        <td>${esc(row.title || '')}</td>
      </tr>`).join('') || '<tr><td colspan="6">本账户没有纸上实验候选。</td></tr>'}</tbody>
    </table></div>` : ''}
  </section>`;
}

function renderRecFromJson(rec, score) {
  const json = rec?.json;
  if (rec?.error) return `<p class="stale-banner">${esc(rec.error)}；未加载结构化动作。</p>${rec.html || ''}`;
  if (state.deskId === 'chatgpt' && rec?.html) return `<p class="stale-banner">ChatGPT 原始研究报告 · ${esc(rec.date)} · 非实时；报告内动作是当时建议，不代表成交。</p>${rec.html}`;
  if (!json?.accounts?.length) return rec?.html || '';
  const strip = state.deskId !== 'chatgpt' && score?.ok
    ? `<p class="muted">判断策略是 Cycle of Price Action。胜率只结算「最可能涨/跌」次日收盘方向，不是带止损的交易胜率。</p>${stageStripHtml(score)}`
    : '';
  return `${strip}${json.accounts.map((book) => recBookHtml(book, score)).join('')}`;
}

function renderRecs(desk) {
  const recs = desk.recs || [];
  const index = document.getElementById('recIndex');
  const body = document.getElementById('recBody');
  if (!recs.length) {
    index.innerHTML = '';
    body.innerHTML = isWritable()
      ? '<p class="empty">还没有推荐操作。点右上角生成。</p>'
      : '<p class="empty">缺文件：ChatGPT 推荐操作目录还没有 YYYY-MM-DD.md / .json。缺失不等于 HOLD，也不代表任务已完成。</p>';
    return;
  }
  const show = (date) => {
    const rec = recs.find((row) => row.date === date) || recs[0];
    index.querySelectorAll('.report-link').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.date === rec.date));
    body.innerHTML = renderRecFromJson(rec, desk.watchScore) || rec.html || '';
    attachRecTickers(body);
  };
  index.innerHTML = recs.map((row) => `<button type="button" class="report-link" data-date="${row.date}"><strong>${row.date}</strong></button>`).join('');
  index.querySelectorAll('.report-link').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.date)));
  show(recs[0].date);
}

function bookTable(rows, emptyText) {
  if (!rows?.length) return `<p class="empty">${emptyText}</p>`;
  return `<table>
    <thead><tr><th>代码</th><th>名称</th><th class="num">数量</th><th>定位</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td class="sym-cell">${row.symbol || ''}</td>
      <td>${row.name || ''}</td>
      <td class="num">${row.qty ?? '—'}</td>
      <td>${row.role || ''}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderCompare(data, accountId) {
  const spec = data.accounts.find((row) => row.id === accountId) || data.accounts[0];
  state.compareAccountId = spec.id;
  localStorage.setItem('kawaii-compare-account', spec.id);
  const stats = spec.overlap.stats;
  document.getElementById('compareTitle').textContent = `${spec.label} · 规则对照`;
  document.getElementById('compareStatus').textContent = spec.chatgpt.blurb && spec.grok.blurb
    ? `${spec.label}：两边持仓重合 ${stats.bothCount} 只，数量不一致 ${stats.qtyMismatch} 只。`
    : spec.label;
  document.getElementById('compareStrip').innerHTML = [
    ['重合', stats.bothCount],
    ['仅 ChatGPT', stats.chatgptOnlyCount],
    ['仅 Grok', stats.grokOnlyCount],
    ['数量不一致', stats.qtyMismatch],
    ['ChatGPT 持仓', stats.chatgptCount],
    ['Grok 持仓', stats.grokCount]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join('');

  document.getElementById('compareAccountBar').innerHTML = data.accounts.map((row) => (
    `<button type="button" class="account-chip ${row.id === spec.id ? 'is-active' : ''}" data-id="${row.id}">${row.label}</button>`
  )).join('');
  document.querySelectorAll('#compareAccountBar .account-chip').forEach((btn) => {
    btn.addEventListener('click', () => renderCompare(data, btn.dataset.id));
  });

  document.getElementById('compareRules').innerHTML = `<table>
    <thead><tr><th>维度</th><th>ChatGPT</th><th>Grok</th></tr></thead>
    <tbody>${spec.rows.map((row) => `<tr><th>${row.key}</th><td>${row.chatgpt}</td><td>${row.grok}</td></tr>`).join('')}</tbody>
  </table>`;
  document.getElementById('compareGptNote').textContent = spec.chatgpt.holdings?.note || spec.chatgpt.blurb || '';
  document.getElementById('compareGrokNote').textContent = spec.grok.holdings?.note || spec.grok.blurb || '';
  document.getElementById('compareGptBook').innerHTML = bookTable(spec.chatgpt.holdings?.positions, '无持仓表。Agentic 对照文件是策略副本。');
  document.getElementById('compareGrokBook').innerHTML = bookTable(spec.grok.holdings?.positions, '空仓，等待扫描或手改。');

  const overlapRows = [
    ...spec.overlap.both.map((row) => `<tr>
      <td class="sym-cell">${row.symbol}</td>
      <td>两边都有</td>
      <td class="num">${row.chatgptQty ?? '—'}</td>
      <td class="num ${row.qtyMatch ? '' : 'neg'}">${row.grokQty ?? '—'}</td>
      <td>${row.qtyMatch ? '数量一致' : '数量不同'}</td>
    </tr>`),
    ...spec.overlap.chatgptOnly.map((row) => `<tr>
      <td class="sym-cell">${row.symbol}</td>
      <td>仅 ChatGPT</td>
      <td class="num">${row.qty ?? '—'}</td>
      <td class="num">—</td>
      <td>${row.role || ''}</td>
    </tr>`),
    ...spec.overlap.grokOnly.map((row) => `<tr>
      <td class="sym-cell">${row.symbol}</td>
      <td>仅 Grok</td>
      <td class="num">—</td>
      <td class="num">${row.qty ?? '—'}</td>
      <td>${row.role || ''}</td>
    </tr>`)
  ];
  document.getElementById('compareOverlap').innerHTML = overlapRows.length
    ? `<table><thead><tr><th>代码</th><th>归属</th><th class="num">ChatGPT 数量</th><th class="num">Grok 数量</th><th>说明</th></tr></thead><tbody>${overlapRows.join('')}</tbody></table>`
    : '<p class="empty">两边都还没有可比较的持仓。</p>';
}

async function loadCompare() {
  const data = await fetch('/api/compare').then((r) => r.json());
  state.compare = data;
  renderCompare(data, state.compareAccountId);
}

function leaderLabel(leader) {
  if (leader === 'grok') return 'Grok 领先';
  if (leader === 'chatgpt') return 'ChatGPT 领先';
  return '打平';
}

function simAccountView(data, accountId) {
  if (accountId === 'all') return data.compare.all;
  return data.compare[accountId] || data.compare.all;
}

function simDay(ledger, date, accountId = 'all') {
  const history = (ledger?.history || []).filter((day) => accountId === 'all' || day.plans?.[accountId]);
  if (date) return history.find((row) => row.date === date) || null;
  return history.at(-1) || null;
}

function renderSimFreshness(data, accountId) {
  const freshness = data.chatgpt?.freshness?.[accountId];
  const banner = document.getElementById('simFreshnessBanner');
  const dates = document.getElementById('simSourceDates');
  dates.replaceChildren();
  document.getElementById('simObservationDate').textContent = `ChatGPT · 当前观察日（美东最近交易日）：${data.observationDate || '未知'} · ${ACCOUNT_LABELS[accountId]} · 只读对照，不下单`;
  banner.replaceChildren();
  banner.hidden = freshness?.stale === false;
  if (!freshness) {
    banner.textContent = '非实时 · 来源日期缺失，无法确认已更新。';
    return;
  }
  if (freshness.stale) {
    const title = document.createElement('strong');
    title.textContent = '非实时 / 已过期 · ChatGPT 数据未齐至当前观察日';
    const reasons = document.createElement('ul');
    for (const reason of freshness.reasons) {
      const item = document.createElement('li');
      item.textContent = reason;
      reasons.append(item);
    }
    banner.append(title, reasons);
  }
  for (const [key, source] of Object.entries(freshness.sources)) {
    const cell = document.createElement('div');
    const label = document.createElement('dt');
    label.textContent = `${source.label} · 最新日期`;
    const value = document.createElement('dd');
    value.textContent = source.date || '缺失 / 日期未知';
    const note = document.createElement('small');
    if (key === 'holdings') note.textContent = source.accounts.map((row) => `${row.label}：${row.date || '日期未知'}`).join('；');
    else if (key === 'settlement') note.textContent = `有有效推荐依据的结算；最近运行记录：${source.latestAttemptDate || '无'}。缺文件占位不算更新。`;
    else if (key === 'recommendation') note.textContent = `可解析 JSON：${source.executableDate || '缺失'}。推荐日期与结算日期分别核对。`;
    else note.textContent = '实际操作日档日期；无成交日档不等于发生交易。';
    value.append(note);
    cell.append(label, value);
    dates.append(cell);
  }
}

function simFillsTable(rows, emptyText) {
  const list = rows || [];
  if (!list.length) return `<p class="empty">${emptyText}</p>`;
  return `<table>
    <thead><tr><th>账户</th><th>代码</th><th>动作</th><th class="num">数量</th><th class="num">价格</th><th class="num">金额</th><th>说明</th></tr></thead>
    <tbody>${list.map((row) => `<tr>
      <td>${row.accountId || ''}</td>
      <td class="sym-cell">${row.symbol || '—'}</td>
      <td><span class="action-tag ${row.action}">${row.action}</span></td>
      <td class="num">${row.qty ?? '—'}</td>
      <td class="num">${row.price == null ? '—' : Number(row.price).toFixed(2)}</td>
      <td class="num">${row.amount == null ? '—' : money2(row.amount)}</td>
      <td>${row.reason || ''}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function simSkipsTable(rows, emptyText) {
  // Legacy ledgers used HOLD for missing inputs. Preserve the ledger, label it truthfully.
  const list = (rows || []).map((row) => row.basis === 'missing-file' || row.basis === 'no-rec-hold'
    ? { ...row, action: 'MISSING', reason: String(row.reason || '缺少推荐').replace(/按 HOLD/g, '仅保留持仓（不代表当日更新）') }
    : row);
  if (!list.length) return `<p class="empty">${emptyText}</p>`;
  return `<table>
    <thead><tr><th>账户</th><th>代码</th><th>动作</th><th>原因</th></tr></thead>
    <tbody>${list.map((row) => `<tr>
      <td>${row.accountId || ''}</td>
      <td class="sym-cell">${row.symbol || '—'}</td>
      <td><span class="action-tag ${row.action}">${row.action}</span></td>
      <td>${row.basis === 'missing-file' || String(row.reason || '').includes('缺文件') ? `<strong>缺文件</strong> · ${row.reason || ''}` : (row.reason || '')}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function simBookTable(rows, emptyText) {
  if (!rows?.length) return `<p class="empty">${emptyText}</p>`;
  return `<table>
    <thead><tr><th>代码</th><th>名称</th><th class="num">数量</th><th class="num">现价</th><th class="num">市值</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td class="sym-cell">${row.symbol || ''}</td>
      <td>${row.name || ''}</td>
      <td class="num">${row.qty ?? '—'}</td>
      <td class="num">${row.last == null ? '—' : Number(row.last).toFixed(2)}</td>
      <td class="num">${money2(row.marketValue)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function simMetrics(summary) {
  const unconfigured = summary?.returnStatus === 'not-configured' && !(summary?.startingNav > 0);
  return [
    ['净值', unconfigured ? '不可计算 / 未配置' : money2(summary?.equity)],
    ['现金', unconfigured ? '—' : money2(summary?.cash)],
    ['持仓数', summary?.positionCount ?? 0],
    ['累计盈亏', unconfigured ? '不可计算 / 未配置' : money2(summary?.pnl)],
    ['收益率', unconfigured || summary?.pnlPct == null ? '不可计算 / 未配置' : pct(summary?.pnlPct)]
  ].map(([label, value]) => `<div><span>${label}</span><strong class="${signedClass(label.includes('盈亏') || label === '收益率' ? summary?.pnl : 0)}">${value}</strong></div>`).join('');
}

function filterSimRows(rows, accountId) {
  if (accountId === 'all') return rows || [];
  return (rows || []).filter((row) => row.accountId === accountId);
}

function simQty(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function renderSimBuild(prefix, build, accountId, today, books) {
  const el = document.getElementById(`${prefix}Build`);
  if (!el) return;
  const ids = accountId === 'all' ? ['main', 'tactical', 'agentic'] : [accountId];
  if (!build?.accounts) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = ids.map((id) => {
    const card = build.accounts[id];
    if (!card) return '';
    const unconfigured = books?.[id]?.returnStatus === 'not-configured';
    const when = !build.signalDate
      ? '缺推荐文件，不建仓'
      : (card.settled
        ? `已在 ${card.executeDate} 开盘结算（open + 5bp）`
        : (card.executeDate && today && card.executeDate < today
          ? `应在 ${card.executeDate} 开盘 + 5bp 成交，该日尚未结算`
          : `下一交易日开盘执行（${card.executeDate} open + 5bp）`));
    const actions = (card.actions || []).length
      ? `<ul>${card.actions.map((row) => `<li><strong>${row.symbol}</strong> ${row.action} ${Number(row.fromPct).toFixed(1)}%→${Number(row.toPct).toFixed(1)}%${row.reason ? ` · ${row.reason}` : ''}</li>`).join('')}</ul>`
      : '<p class="sim-build-meta">没有可建仓的 BUY/ADD。</p>';
    const pending = (card.pending || []).length
      ? `<ul>${card.pending.map((row) => `<li>${row.symbol} 买入 +${simQty(row.qty)} @ decision ${row.decision ?? '—'} 到期 ${row.expires || '—'}</li>`).join('')}</ul>`
      : '<p class="sim-build-meta">没有待执行买单。</p>';
    return `<article class="sim-build">
      <h3>${card.label || id} · ${build.signalDate || '—'}</h3>
      <p class="sim-build-meta">${when}</p>
      <p class="sim-build-meta">${unconfigured ? 'NAV 不可计算 / 未配置 · 现金 — · 起始资金未设置' : `NAV ${money2(card.nav)} · 现金 ${card.cashPct ?? '—'}% · 持仓 ${card.positionCount ?? 0} · ${card.phase || '—'}`}</p>
      <h4>Actions</h4>
      ${actions}
      <h4>Pending T+1</h4>
      ${pending}
      <p class="sim-build-foot">模拟组合 · 不是买卖建议 · 目标 ${card.targetPct}% · 每日 ${card.tranchePct}% · ${card.note || build.note || ''}</p>
    </article>`;
  }).join('');
}

function renderSimSide(prefix, ledger, day, summary, accountId, today) {
  renderSimBuild(prefix, ledger?.build, accountId, today, ledger?.accounts);
  document.getElementById(`${prefix}Note`).textContent = `${day?.date ? `展示 ${day.date} 的模拟记录。` : '尚无模拟记录。'}仅按已有推荐 JSON 模拟；缺文件不代表 HOLD 建议或当日更新。不下真实单。`;
  document.getElementById(`${prefix}FillsTitle`).textContent = day?.date ? `模拟成交 · ${day.date}` : '模拟成交 · 尚未结算';
  document.getElementById(`${prefix}Metrics`).innerHTML = simMetrics(summary);
  const spark = sparkSvg(ledger.navSeries?.[accountId] || ledger.navSeries?.all || []);
  document.getElementById(`${prefix}Spark`).innerHTML = spark
    ? `<div class="sim-spark">${spark}</div>`
    : '<p class="muted">结算后才会有净值曲线。</p>';
  const fills = filterSimRows(day?.fills, accountId);
  const skips = filterSimRows(day?.skips, accountId);
  document.getElementById(`${prefix}Fills`).innerHTML = simFillsTable(fills, day ? `${day.date} 无模拟成交；请核对来源日期和未跟单原因。` : '尚无结算记录，不能视为当日 HOLD。');
  document.getElementById(`${prefix}Skips`).innerHTML = simSkipsTable(skips, '没有未跟单记录。');
  const book = accountId === 'all'
    ? ACCOUNT_IDS.flatMap((id) => (ledger.accounts[id]?.positions || []).map((row) => ({ ...row, accountId: id })))
    : (ledger.accounts[accountId]?.positions || []);
  const empty = prefix === 'simGrok' ? 'Grok 模拟操作空仓。' : 'ChatGPT 模拟操作空仓。缺文件或 WAIT 不会编造买单。';
  if (accountId === 'all') {
    document.getElementById(`${prefix}Book`).innerHTML = book.length
      ? `<table>
        <thead><tr><th>账户</th><th>代码</th><th>名称</th><th class="num">数量</th><th class="num">现价</th><th class="num">市值</th></tr></thead>
        <tbody>${book.map((row) => `<tr>
          <td>${row.accountId}</td>
          <td class="sym-cell">${row.symbol || ''}</td>
          <td>${row.name || ''}</td>
          <td class="num">${row.qty ?? '—'}</td>
          <td class="num">${row.last == null ? '—' : Number(row.last).toFixed(2)}</td>
          <td class="num">${money2(row.marketValue)}</td>
        </tr>`).join('')}</tbody>
      </table>`
      : `<p class="empty">${empty}</p>`;
    return;
  }
  document.getElementById(`${prefix}Book`).innerHTML = simBookTable(book, empty);
}

const ACCOUNT_IDS = ['main', 'tactical', 'agentic'];
const ACCOUNT_LABELS = { all: '全部', main: '主账户', tactical: '战术', agentic: 'Agentic' };

function renderSim(data, accountId) {
  const id = ACCOUNT_LABELS[accountId] ? accountId : 'all';
  state.simAccountId = id;
  localStorage.setItem('kawaii-sim-account', id);
  const view = simAccountView(data, id);
  const dateInput = document.getElementById('simDate');
  if (dateInput && !dateInput.value) dateInput.value = data.today;
  document.getElementById('brandKicker').textContent = 'Kawaii Research · 纸上对照';
  document.getElementById('brandTitle').textContent = '模拟操作';
  document.getElementById('brandSub').textContent = '完全跟 Grok 当日推荐操作 JSON vs 完全跟 ChatGPT 当日推荐操作 JSON · 不是实盘';
  document.getElementById('stancePill').textContent = 'PAPER';
  document.getElementById('reportDate').textContent = `观察日 ${data.observationDate || '未知'}`;
  renderSimFreshness(data, id);

  const grokSum = view.grok;
  const gptSum = view.chatgpt;
  document.getElementById('simStrip').innerHTML = [
    ['Grok 净值', money2(grokSum?.equity), grokSum?.pnl],
    ['ChatGPT 净值', money2(gptSum?.equity), gptSum?.pnl],
    ['领先', leaderLabel(view.leader), view.delta],
    ['Grok 盈亏', money2(grokSum?.pnl), grokSum?.pnl],
    ['ChatGPT 盈亏', money2(gptSum?.pnl), gptSum?.pnl]
  ].map(([label, value, signed]) => `<article><span>${label}</span><strong class="${signedClass(typeof signed === 'number' ? signed : 0)}">${value}</strong></article>`).join('');

  const lastDate = data.lastDate;
  const grokRec = data.grok?.recFile;
  const gptRec = data.chatgpt?.recFile;
  const recStatus = (file, name) => {
    if (!file) return `${name} 推荐操作未检查`;
    return file.found ? `${name} 有 ${file.date}.json` : `缺文件：${name} 没有 ${file.date}.json`;
  };
  document.getElementById('simStatus').textContent = lastDate
    ? `最近模拟运行记录 ${lastDate}（不代表各来源均已更新）。该日 Grok 模拟成交 ${data.compare?.all?.grokFills ?? 0} 笔，ChatGPT ${data.compare?.all?.chatgptFills ?? 0} 笔。${recStatus(grokRec, 'Grok')}；${recStatus(gptRec, 'ChatGPT')}。`
    : `尚未结算。${recStatus(grokRec, 'Grok')}；${recStatus(gptRec, 'ChatGPT')}。缺文件仅保留持仓，不计为当日更新。`;

  document.getElementById('simAccountBar').innerHTML = ['all', 'main', 'tactical', 'agentic'].map((key) => (
    `<button type="button" class="account-chip ${key === id ? 'is-active' : ''}" data-id="${key}">${ACCOUNT_LABELS[key]}</button>`
  )).join('');
  document.querySelectorAll('#simAccountBar .account-chip').forEach((btn) => {
    btn.addEventListener('click', () => renderSim(data, btn.dataset.id));
  });

  const rows = ['main', 'tactical', 'agentic', 'all'].map((key) => {
    const row = data.compare[key];
    const label = key === 'all' ? '合计' : ACCOUNT_LABELS[key];
    return `<tr>
      <th>${label}</th>
      <td class="num">${money2(row.grok?.equity)}</td>
      <td class="num">${money2(row.chatgpt?.equity)}</td>
      <td class="num ${signedClass(row.grok?.pnl)}">${money2(row.grok?.pnl)}</td>
      <td class="num ${signedClass(row.chatgpt?.pnl)}">${money2(row.chatgpt?.pnl)}</td>
      <td class="num">${row.grokFills ?? 0}</td>
      <td class="num">${row.chatgptFills ?? 0}</td>
      <td>${leaderLabel(row.leader)}</td>
    </tr>`;
  }).join('');
  document.getElementById('simCompareTable').innerHTML = `<table>
    <thead><tr><th>账户</th><th class="num">Grok 净值</th><th class="num">ChatGPT 净值</th><th class="num">Grok 盈亏</th><th class="num">ChatGPT 盈亏</th><th class="num">Grok 成交</th><th class="num">ChatGPT 成交</th><th>领先</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  const grokDay = simDay(data.grok, null, id);
  const gptDay = simDay(data.chatgpt, null, id);
  renderSimSide('simGrok', data.grok, grokDay, grokSum, id, data.today);
  renderSimSide('simGpt', data.chatgpt, gptDay, gptSum, id, data.today);
}

async function loadSim() {
  const data = await fetch(`/api/sim?account=${state.simAccountId}`).then((r) => r.json());
  state.sim = data;
  renderSim(data, state.simAccountId);
}

async function runSim() {
  const date = document.getElementById('simDate').value || '';
  document.getElementById('simStatus').textContent = `正在按 ${date || '今日'} 结算，拉取 Nasdaq 报价中。不会下真实单。`;
  const res = await fetch(`/api/sim/run?date=${encodeURIComponent(date)}`, { method: 'POST' });
  const data = await res.json();
  state.sim = data;
  if (data.error) {
    document.getElementById('simStatus').textContent = `结算失败：${data.error}`;
    return;
  }
  renderSim(data, state.simAccountId);
  const grokMark = data.grokRecFound === false ? '缺文件' : (data.grokRecFound ? '有推荐操作文件' : '');
  const gptMark = data.chatgptRecFound === false ? '缺文件' : (data.chatgptRecFound ? '有推荐操作文件' : '');
  const rebuilt = data.rebuilt ? `从 seed ${data.rebuilt.from} 全量重放 ${data.rebuilt.days} 个交易日。` : '';
  document.getElementById('simStatus').textContent = data.alreadySettled
    ? `该日已有结算，保留历史记录。${data.note || ''}`
    : `已运行 ${data.date} 模拟结算。${rebuilt}Grok ${grokMark || ''}成交 ${data.lastRun?.grok?.fills?.length ?? 0} 笔，ChatGPT ${gptMark || ''}成交 ${data.lastRun?.chatgpt?.fills?.length ?? 0} 笔。缺文件不算有效更新；时效见上方来源日期。真实持仓未被覆盖。`;
}

async function resetSimBooks() {
  if (!window.confirm('重置会清空两本模拟账本，并从同一 Day0 快照播种（主/战术/Agentic 都用 Grok 持仓档案）。ChatGPT 没有独立 Agentic 表，所以两边 Agentic 起点相同。不会改真实持仓。继续？')) return;
  document.getElementById('simStatus').textContent = '正在重置模拟操作。';
  const data = await fetch('/api/sim/reset', { method: 'POST' }).then((r) => r.json());
  state.sim = data;
  renderSim(data, state.simAccountId);
  document.getElementById('simStatus').textContent = '模拟操作已重置。真实 Grok / ChatGPT 持仓档案未改。';
}

function actualAccountLabel(id) {
  return ACCOUNT_LABELS[id] || id || '—';
}

function renderActuals(days, date) {
  document.getElementById('brandKicker').textContent = `${state.desk?.desk?.label || 'Grok'} · 真实成交`;
  document.getElementById('brandTitle').textContent = '实际操作';
  document.getElementById('brandSub').textContent = '只记当天真实做过的交易。草稿不记。默认 live_trading=false';
  document.getElementById('stancePill').textContent = 'LIVE LOG';
  const index = document.getElementById('actualIndex');
  const table = document.getElementById('actualTable');
  const body = document.getElementById('actualBody');
  const dateInput = document.getElementById('actualDate');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }
  if (!days.length) {
    index.innerHTML = '<p class="empty">还没有实际操作。</p>';
    table.innerHTML = '<p class="empty">当天没有真实成交。手改追加，或等 Agentic 真下单成功后再自动记。</p>';
    body.innerHTML = '';
    return;
  }
  const showDate = date || days[0].date;
  const day = days.find((row) => row.date === showDate) || days[0];
  if (dateInput) dateInput.value = day.date;
  index.innerHTML = days.map((row) => (
    `<button type="button" class="report-link ${row.date === day.date ? 'is-active' : ''}" data-date="${row.date}"><strong>${row.date}</strong><span>${row.entries?.length || 0} 笔</span></button>`
  )).join('');
  index.querySelectorAll('.report-link').forEach((btn) => {
    btn.addEventListener('click', () => renderActuals(days, btn.dataset.date));
  });
  const rows = day.entries || [];
  table.innerHTML = rows.length
    ? `<table>
      <thead><tr><th>账户</th><th>代码</th><th>方向</th><th class="num">数量</th><th class="num">价格</th><th>来源</th><th>备注</th><th></th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${actualAccountLabel(row.accountId)}</td>
        <td class="sym-cell">${row.symbol || ''}</td>
        <td><span class="action-tag ${row.side}">${row.side}</span></td>
        <td class="num">${row.qty ?? '—'}</td>
        <td class="num">${row.price == null ? '—' : Number(row.price).toFixed(2)}</td>
        <td>${row.source || 'manual'}</td>
        <td>${row.note || ''}</td>
        <td><button type="button" class="text-btn actual-del" data-id="${row.id}" data-date="${day.date}">删除</button></td>
      </tr>`).join('')}</tbody>
    </table>`
    : '<p class="empty">这一天没有实际成交。战术 / Agentic 点「写入扫描成交」会从 Robinhood 已成交补进来。草稿不会写进这里。</p>';
  body.innerHTML = day.html || '';
  table.querySelectorAll('.actual-del').forEach((btn) => {
    btn.addEventListener('click', () => deleteActual(btn.dataset.date, btn.dataset.id));
  });
}

async function loadActuals(date) {
  const advisor = state.deskId === 'chatgpt' ? 'chatgpt' : 'grok';
  const days = await fetch(`/api/actuals?advisor=${advisor}`).then((r) => r.json());
  state.actuals = days;
  renderActuals(Array.isArray(days) ? days : [], date);
}

async function importActuals() {
  const advisor = state.deskId === 'chatgpt' ? 'chatgpt' : 'grok';
  document.getElementById('actualStatus').textContent = '正在把战术 / Agentic 的 Robinhood 成交写入实际操作。';
  const data = await fetch('/api/actuals/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ advisor })
  }).then((r) => r.json());
  document.getElementById('actualStatus').textContent = data.error
    ? (data.message || data.error)
    : (data.message || '没有新的成交。');
  if (!data.error) await loadActuals();
}

async function saveActual(event) {
  event.preventDefault();
  const advisor = state.deskId === 'chatgpt' ? 'chatgpt' : 'grok';
  const payload = {
    advisor,
    date: document.getElementById('actualDate').value,
    accountId: document.getElementById('actualAccount').value,
    symbol: document.getElementById('actualSymbol').value,
    side: document.getElementById('actualSide').value,
    qty: Number(document.getElementById('actualQty').value),
    price: Number(document.getElementById('actualPrice').value),
    note: document.getElementById('actualNote').value
  };
  document.getElementById('actualStatus').textContent = '正在写入实际操作。';
  const data = await fetch('/api/actuals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((r) => r.json());
  if (data.error) {
    document.getElementById('actualStatus').textContent = data.message || data.error;
    return;
  }
  document.getElementById('actualSymbol').value = '';
  document.getElementById('actualQty').value = '';
  document.getElementById('actualPrice').value = '';
  document.getElementById('actualNote').value = '';
  document.getElementById('actualStatus').textContent = `已手改追加 ${data.entry?.symbol} ${data.entry?.side}。草稿不会出现在这里。`;
  await loadActuals(data.date);
}

async function deleteActual(date, id) {
  const advisor = state.deskId === 'chatgpt' ? 'chatgpt' : 'grok';
  const data = await fetch(`/api/actuals?advisor=${advisor}&date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => r.json());
  document.getElementById('actualStatus').textContent = data.error ? (data.message || data.error) : '已删除这条实际操作。';
  if (!data.error) await loadActuals(date);
}

function renderReports(reports) {
  const index = document.getElementById('reportIndex');
  const body = document.getElementById('reportBody');
  if (!reports.length) {
    index.innerHTML = '<p class="empty">还没有 Agentic 叙事日报。</p>';
    body.innerHTML = '<p class="empty">点「手动更新」生成账户快照日报。</p>';
    document.getElementById('reportStatus').textContent = '尚无日报，可手动更新。';
    return;
  }
  const show = (date) => {
    const report = reports.find((row) => row.date === date) || reports[0];
    index.querySelectorAll('.report-link').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.date === report.date));
    body.innerHTML = report.html || '<p class="empty">无正文。</p>';
    const snapshot = report.json;
    document.getElementById('reportStatus').textContent = `日报日期：${report.date} · 持仓来源：${snapshot?.asOf || '日期未知'}${snapshot?.generatedAt ? ` · 生成时间：${new Date(snapshot.generatedAt).toLocaleString('zh-CN')}` : ''}${report.stale || snapshot?.stale ? ` · 非实时 / 已过期：日报或持仓来源未更新至观察日 ${report.observationDate || '当前'}。` : ''}`;
  };
  index.innerHTML = reports.map((row) => `<button type="button" class="report-link" data-date="${row.date}"><strong>${row.date}</strong><span>${row.stance || ''} ${row.headline || ''}</span></button>`).join('');
  index.querySelectorAll('.report-link').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.date)));
  show(reports[0].date);
}

let reportsLoading = false;
async function loadReports({ refresh = false } = {}) {
  if (reportsLoading) return;
  reportsLoading = true;
  const button = document.getElementById('reportRefreshBtn');
  const status = document.getElementById('reportStatus');
  button.disabled = true;
  button.textContent = refresh ? '更新中…' : '读取中…';
  status.textContent = refresh ? '正在读取已有持仓和实际成交，更新账户快照日报。不下单。' : '正在读取已保存的叙事日报。';
  try {
    const response = await fetch(refresh ? '/api/reports/run' : '/api/reports', { method: refresh ? 'POST' : 'GET' });
    const data = await response.json();
    if (!response.ok || data.error || data.ok === false) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    renderReports(refresh ? data.reports : data);
    if (refresh) {
      status.textContent = data.report.preserved
        ? data.report.message
        : `已手动更新并保存 ${data.report.date}。${status.textContent}`;
    }
  } catch (error) {
    status.textContent = `${refresh ? '手动更新' : '日报读取'}失败：${error.message}。保留当前展示，可点击「手动更新」重试。`;
  } finally {
    reportsLoading = false;
    button.disabled = false;
    button.textContent = '手动更新';
  }
}

async function loadAccount(id) {
  const desk = await fetch(`/api/desk?desk=${state.deskId}&account=${id}`).then((r) => r.json());
  state.desk = desk;
  state.draftRows = [...(desk.holdings?.positions || [])];
  renderDeskBar(desk.config.desks);
  renderAccountBar(desk.config);
  renderOverview(desk);
  renderBook(desk);
  renderRecs(desk);
  document.getElementById('strategyBody').innerHTML = desk.strategy?.html || '<p class="empty">策略缺失。</p>';
  if (!document.getElementById('panel-actuals')?.hidden) loadActuals();
  if (!document.getElementById('panel-sim')?.hidden) loadSim();
  loadTradable().catch((error) => {
    const a = document.getElementById('tradableStatus');
    if (a) a.textContent = `今日买卖载入失败：${error.message}`;
  });
  loadBrief().catch((error) => {
    const a = document.getElementById('briefStatus');
    if (a) a.textContent = `Agentic 意见载入失败：${error.message}`;
  });
  fetch(`/api/tape?desk=${state.deskId}&account=${id}`).then((r) => r.json()).then((tape) => {
    state.quotes = tape.quotes || {};
    renderTape(state.quotes);
  }).catch(() => {});
}

async function saveMain() {
  const res = await fetch(`/api/accounts/main/holdings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asOf: new Date().toISOString(),
      cash: state.desk.holdings?.cash ?? null,
      costTotal: state.desk.holdings?.costTotal ?? null,
      note: '网页手改。',
      positions: state.draftRows
    })
  });
  const data = await res.json();
  document.getElementById('statusLine').textContent = data.error ? `保存失败：${data.error}` : `已保存 ${data.positions.length} 条到 Obsidian 持仓档案。`;
  if (!data.error) loadAccount('main');
}

async function importHoldingsPayload(payload) {
  const account = currentAccount();
  if (!account || (account.source === 'manual' && account.id !== 'agentic')) {
    document.getElementById('scanStatus').textContent = '主账户请用手改。Agentic 可以导入持仓 JSON。';
    return;
  }
  const res = await fetch(`/api/accounts/${account.id}/holdings/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  document.getElementById('scanStatus').textContent = data.error
    || `${data.staleLabel || '已导入'} · ${data.positions?.length ?? 0} 只。不下单。`;
  if (!data.error) loadAccount(account.id);
}

async function applyScan() {
  let payload;
  try {
    payload = JSON.parse(document.getElementById('scanInput').value);
  } catch {
    document.getElementById('scanStatus').textContent = 'JSON 无法解析。';
    return;
  }
  await importHoldingsPayload(payload);
}

async function importHoldingsFile(file) {
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    document.getElementById('scanStatus').textContent = 'JSON 无法解析。';
    return;
  }
  await importHoldingsPayload(payload);
}

async function runRecs() {
  document.getElementById('recStatus').textContent = '正在生成，拉取行情中。';
  const advisor = state.deskId === 'chatgpt' ? 'chatgpt' : 'grok';
  const res = await fetch(`/api/recommendations/run?advisor=${advisor}`, { method: 'POST' });
  const data = await res.json();
  document.getElementById('recStatus').textContent = data.error
    ? data.error
    : data.preserved
      ? `已保留 ${data.date} ChatGPT 原生推荐，未覆盖。`
      : `已写入 ${data.date} 推荐操作。`;
  if (!data.error) loadAccount(state.accountId);
}

function dailyResultText(data) {
  const completion = data.completion;
  const failures = completion?.errors?.map(row => `${row.label}：${row.reason}`) || [];
  const warnings = completion?.warnings || [];
  const partial = data.ok === false || data.verify?.complete === false || failures.length > 0;
  const label = partial ? '部分完成' : warnings.length ? '已完成，但数据有缺口' : completion?.status === 'complete' ? '任务已完成' : '任务返回，完成状态未核验';
  return [`${label} ${data.date || ''}`, ...failures, ...warnings].join('；');
}

async function runDaily() {
  const recStatus = document.getElementById('recStatus');
  recStatus.textContent = '正在跑每日流水：真实持仓（本机不请求 Robinhood）→ 推荐操作 → 模拟操作 → 实际操作。不会下真实单。';
  const res = await fetch('/api/daily/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipScan: true })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    recStatus.textContent = `每日流水失败：${data.error || res.status}`;
    return;
  }
  const holdNotes = ['tactical', 'agentic'].map((id) => data.holdings?.[id]?.note).filter(Boolean).join(' / ');
  const recNote = data.recommendations?.chatgptNote || '推荐操作已写入';
  const simNote = data.sim?.error ? `模拟未结算：${data.sim.error}` : `模拟 Grok 成交 ${data.sim?.grokFills ?? 0} 笔 / ChatGPT ${data.sim?.chatgptFills ?? 0} 笔`;
  recStatus.textContent = `${dailyResultText(data)}。${holdNotes || ''} ${recNote}；${simNote}；实际操作：${data.actuals?.grok?.message || '未返回成交信息'}。`;
  await loadAccount(state.accountId);
  loadSim().catch(() => {});
  loadActuals().catch(() => {});
}

async function refreshAll() {
  const button = document.getElementById('refreshAllBtn');
  const status = document.getElementById('refreshAllStatus');
  if (!button || button.disabled) return;
  button.disabled = true;
  const started = Date.now();
  const tick = () => { button.textContent = `更新中… ${Math.round((Date.now() - started) / 1000)}s`; };
  tick();
  const timer = setInterval(tick, 1000);
  if (status) status.textContent = '持仓 → 叙事日报 → 推荐 → 模拟结算 → 今日买卖 / 价位图 → 期权 → 每日观察 → 算卦 → Agentic意见 → 止损 / 风控 → 纸上实验。不下单，本机不打 Robinhood。';
  try {
    const res = await fetch('/api/daily/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipScan: true })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `更新失败 ${res.status}`);
    const parts = [
      dailyResultText(data),
      data.recommendations?.grok && !data.recommendations.grokError ? 'Grok 推荐已写' : 'Grok 推荐未完成',
      data.recommendations?.chatgptNote || (data.recommendations?.chatgpt ? 'ChatGPT 推荐已处理' : 'ChatGPT 推荐未完成'),
      data.options?.ok ? `期权扫描 ${data.options.scanned ?? 0}` : '期权未完成',
      data.watchlist?.ok ? `美股观察 ${data.watchlist.scanned ?? 0}` : '美股观察未完成',
      data.watchlistCn?.ok ? `A股观察 ${data.watchlistCn.scanned ?? 0}` : 'A股观察未完成',
      data.posters?.ok ? '价位图已写' : '价位图未完成',
      data.oracle?.ok ? `算卦 ${data.oracle.qimen || ''}` : '算卦未完成',
      data.sim?.error ? `模拟未结算：${data.sim.error}` : data.sim?.waitsForClose ? `模拟已结算到 ${data.sim.date}，${data.date} 收盘后再记今天` : `模拟已结算到 ${data.sim?.date || '—'}`,
      !data.paper?.ok ? '纸上实验未完成' : data.paper.outsideSession ? `纸上实验：非交易时段只回放止损${data.paper.stopFills?.length ? `（触发 ${data.paper.stopFills.length}）` : ''}` : '纸上实验已跑',
      `用时 ${Math.round((Date.now() - started) / 1000)}s`
    ];
    if (status) status.textContent = parts.join(' · ');
    await loadAccount(state.accountId).catch(() => {});
    const active = document.querySelector('.tab.is-active');
    if (active?.dataset.tab === 'overview') await loadBrief().catch(() => {});
    else active?.click();
  } catch (error) {
    if (status) status.textContent = `更新失败：${error.message}`;
  } finally {
    clearInterval(timer);
    button.disabled = false;
    button.textContent = '一键更新';
  }
}

async function main() {
  setInterval(() => {
    const now = new Date();
    document.getElementById('clockEt').textContent = `${fmtTime(now, 'America/New_York')} ET`;
    document.getElementById('clockBj').textContent = fmtTime(now, 'Asia/Shanghai');
  }, 1000);
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
    setActiveTab(btn.dataset.tab);
    if (btn.dataset.tab === 'compare') loadCompare();
    if (btn.dataset.tab === 'sim') loadSim();
    if (btn.dataset.tab === 'paper') loadPaper().catch((error) => {
      const status = document.getElementById('paperStatus');
      if (status) status.textContent = `纸上实验载入失败：${error.message}`;
    });
    if (btn.dataset.tab === 'actuals') loadActuals();
    if (btn.dataset.tab === 'reports') loadReports();
    if (btn.dataset.tab === 'guards') loadGuards().catch((error) => {
      const status = document.getElementById('guardStatus');
      if (status) status.textContent = `止损看板失败：${error.message}`;
    });
    if (btn.dataset.tab === 'review') loadReview(state.deskId).catch((error) => {
      const status = document.getElementById('reviewStatus');
      if (status) status.textContent = `复盘失败：${error.message}`;
    });
    if (btn.dataset.tab === 'universe') ensureScreenerLoaded();
    if (btn.dataset.tab === 'watch') loadWatchlist().catch((error) => {
      const status = document.getElementById('watchStatus');
      if (status) status.textContent = `观察板载入失败：${error.message}`;
    });
    if (btn.dataset.tab === 'options') {
      loadOptionStrategies()
        .then(() => loadOptions())
        .catch((error) => {
          const status = document.getElementById('optionStatus');
          if (status) status.textContent = `期权页载入失败：${error.message}`;
        });
    }
    if (btn.dataset.tab === 'oracle') {
      loadOracle().catch((error) => {
        const status = document.getElementById('oracleStatus');
        if (status) status.textContent = `算卦页载入失败：${error.message}`;
      });
    }
  }));
  document.getElementById('addRowBtn').addEventListener('click', () => {
    state.draftRows.push({ symbol: '', name: '', qty: 0, role: '', theme: '' });
    renderBook(state.desk);
  });
  document.getElementById('saveBookBtn').addEventListener('click', saveMain);
  document.getElementById('applyScanBtn').addEventListener('click', applyScan);
  document.getElementById('scanFileBtn')?.addEventListener('click', () => document.getElementById('scanFile')?.click());
  document.getElementById('scanFile')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    importHoldingsFile(file);
  });
  document.getElementById('runRecsBtn').addEventListener('click', runRecs);
  document.getElementById('runDailyBtn')?.addEventListener('click', runDaily);
  document.getElementById('refreshAllBtn')?.addEventListener('click', refreshAll);
  document.getElementById('reportRefreshBtn')?.addEventListener('click', () => loadReports({ refresh: true }));
  document.getElementById('simRunBtn').addEventListener('click', runSim);
  document.getElementById('simResetBtn').addEventListener('click', resetSimBooks);
  document.getElementById('actualForm')?.addEventListener('submit', saveActual);
  document.getElementById('actualImportBtn')?.addEventListener('click', () => {
    importActuals().catch((error) => {
      document.getElementById('actualStatus').textContent = `写入成交失败：${error.message}`;
    });
  });
  document.getElementById('posterLoadBtn')?.addEventListener('click', loadPosters);
  document.getElementById('posterWriteBtn')?.addEventListener('click', runPosters);
  document.getElementById('tradableRefreshBtn')?.addEventListener('click', () => loadTradable());
  document.getElementById('tradableWriteBtn')?.addEventListener('click', () => loadTradable({ write: true }));
  bindOptionsUi();
  bindOracleUi();
  bindPaperUi();
  bindWatchUi();
  bindBriefUi();
  bindOpsUi();

  await loadAccount(state.accountId);
  loadCompare().catch(() => {});
  await loadReports();
}

main().catch((error) => {
  document.getElementById('statusLine').textContent = `载入失败：${error.message}`;
});
