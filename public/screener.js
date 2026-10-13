import { observationHtml, validDate, versionLabel } from './watch-view.js';

let drawerRequest = 0;
let drawerOpener = null;

const PRESETS = [
  { id: 'all', label: '全部候选', description: '显示当前 List 分页中的全部股票，包括暂时缺少完整估值的公司。' },
  { id: 'undervalued', label: '低估股票', description: '当前价格低于综合模型合理价值的公司。' },
  { id: 'high-safety', label: '高安全边际', description: '模型折价至少 20%，并且具备可用财务依据。' },
  { id: 'positive-fcf', label: '正自由现金流 + 低估', cnLabel: '正经营现金流 + 低估', description: '现金流为正，同时低于模型合理价值。' },
  { id: 'quality-value', label: '优质低估', description: '质量评分较高，并且具备一定估值折价。' },
  { id: 'dividend', label: '低估股息股', description: '支付股息且低于模型合理价值。' },
  { id: 'large-cap', label: '大盘价值股', cnLabel: 'A股大盘价值', description: '大市值且具有正安全边际。' },
  { id: 'quality', label: '优质复利股', description: '盈利能力良好、质量较高，并能持续产生现金流。' },
  { id: 'capitulation', label: '暴跌机会', description: '短期大幅回撤，但基本质量仍然较高。' }
];

const STATUS_ZH = {
  'Strongly Undervalued': '显著低估',
  Undervalued: '低估',
  'Near Fair Value': '接近合理价值',
  'Above Fair Value': '高于合理价值',
  'Historical Anchor': '仅年报锚点',
  'Model unavailable': '暂无模型估值',
  'Model anomaly': '模型异常',
  'Financial facts unavailable': '年度财务数据不足',
  'Pre-revenue model unavailable': '尚未商业化，暂不估值',
  'Sales value below net debt': '营收估值不足以覆盖净负债',
  'SEC filer unavailable': '未找到 SEC 申报主体',
  'Loading data': '数据加载中'
};

const SECTOR_ZH = {
  Technology: '科技',
  Financials: '金融',
  'Consumer Discretionary': '可选消费',
  'Consumer Staples': '必需消费',
  'Communication Services': '通信服务',
  Healthcare: '医疗健康',
  Industrials: '工业',
  Energy: '能源',
  Utilities: '公用事业',
  Materials: '材料',
  'Real Estate': '房地产',
  Unclassified: '未分类'
};

const RISK_ZH = { Low: '低', Medium: '中', High: '高', Unrated: '未评级' };
const CONFIDENCE_ZH = { High: '高', Medium: '中', Low: '低' };

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const cny = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 });
const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const compactCny = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', notation: 'compact', maximumFractionDigits: 1 });

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const signedPct = (value, digits = 1) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

const money = (value, currency = 'USD') => {
  if (value == null || !Number.isFinite(value)) return '—';
  return currency === 'CNY' ? cny.format(value) : usd.format(value);
};

const compact = (value, currency = 'USD') => {
  if (value == null || !Number.isFinite(value)) return '—';
  return currency === 'CNY' ? compactCny.format(value) : compactUsd.format(value);
};

const formatMultiple = (value) => value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}×`;
const formatNumber = (value, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const formatDate = (value, withTime = false) => {
  if (!value) return '暂无数据';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
};

const statusClass = (status) => `status-${String(status || '').toLowerCase().replaceAll(' ', '-')}`;

function filterStocks(stocks, presetId) {
  const rules = {
    all: () => true,
    undervalued: (stock) => stock.marginOfSafety > 0,
    'high-safety': (stock) => stock.marginOfSafety >= 20,
    'positive-fcf': (stock) => stock.freeCashFlow > 0 && stock.marginOfSafety > 0,
    'quality-value': (stock) => stock.qualityScore >= 65 && stock.marginOfSafety >= 5,
    dividend: (stock) => stock.dividendYield > 0 && stock.marginOfSafety > 0,
    'large-cap': (stock) => stock.marketCap >= 200_000_000_000 && stock.marginOfSafety > 0,
    quality: (stock) => stock.qualityScore >= 68 && stock.freeCashFlow > 0,
    capitulation: (stock) => stock.qualityScore >= 65 && (stock.drawdown30d <= -7 || stock.dailyChange <= -3)
  };
  return stocks.filter(rules[presetId] ?? (() => true));
}

function calculateResearchDcf(stock, growth, wacc, terminalGrowth) {
  if (!(stock?.fcfPerShare > 0) || !(wacc > terminalGrowth)) return null;
  let projectedFcf = stock.fcfPerShare;
  let presentValue = 0;
  for (let year = 1; year <= 5; year += 1) {
    projectedFcf *= 1 + growth / 100;
    presentValue += projectedFcf / ((1 + wacc / 100) ** year);
  }
  const terminalValue = projectedFcf * (1 + terminalGrowth / 100) / ((wacc - terminalGrowth) / 100);
  return Math.max(0, presentValue + terminalValue / ((1 + wacc / 100) ** 5) - (stock.netDebtPerShare ?? 0));
}

const state = {
  market: 'us',
  watchlistId: 'kawaii-curated',
  presetId: 'all',
  page: 1,
  pageSize: 12,
  sort: { key: 'sourceOrder', direction: 'asc' },
  search: '',
  modeledOnly: false,
  data: null,
  loading: false,
  research: null,
  assumptions: { growth: 6, wacc: 9, terminalGrowth: 2.5 }
};

function presetLabel(preset) {
  return state.market === 'cn' && preset.cnLabel ? preset.cnLabel : preset.label;
}

function visibleStocks() {
  const query = state.search.trim().toLowerCase();
  const filtered = filterStocks(state.data?.stocks ?? [], state.presetId).filter((stock) => {
    if (state.modeledOnly && !(stock.fairValue > 0)) return false;
    if (!query) return true;
    return stock.symbol.toLowerCase().includes(query) || String(stock.company || '').toLowerCase().includes(query);
  });
  return [...filtered].sort((a, b) => {
    const left = a[state.sort.key] ?? -Infinity;
    const right = b[state.sort.key] ?? -Infinity;
    return state.sort.direction === 'asc' ? left - right : right - left;
  });
}

function renderChrome() {
  const current = PRESETS.find((row) => row.id === state.presetId) ?? PRESETS[0];
  document.getElementById('screenerTitle').textContent = state.market === 'cn' ? 'A股观察池' : '美股观察池';
  document.getElementById('screenerMarket').innerHTML = ['us', 'cn'].map((id) => (
    `<button type="button" class="${id === state.market ? 'is-active' : ''}" data-market="${id}">${id === 'us' ? '美股' : 'A股'}</button>`
  )).join('');
  document.getElementById('screenerPresets').innerHTML = PRESETS.map((preset) => (
    `<button type="button" class="preset-chip ${preset.id === state.presetId ? 'is-active' : ''}" data-preset="${preset.id}">${escapeHtml(presetLabel(preset))}</button>`
  )).join('');
  document.getElementById('screenerPresetNote').textContent = current.description;
  document.getElementById('screenerModeledBtn').classList.toggle('is-active', state.modeledOnly);
  const lists = state.data?.watchlists ?? [];
  document.getElementById('listPills').innerHTML = lists.map((list) => (
    `<button type="button" class="pill ${list.id === state.watchlistId ? 'is-active' : ''}" data-watchlist="${escapeHtml(list.id)}">${escapeHtml(list.title)} · ${list.total}</button>`
  )).join('');
  document.getElementById('screenerMethod').textContent = state.data
    ? `${state.data.methodology || ''} 行情 ${formatDate(state.data.marketDataAsOf, true)} · 财务截至 ${formatDate(state.data.fundamentalsAsOf)}`
    : '正在读取 List 与公开财报。';
}

function renderTable() {
  const stocks = visibleStocks();
  const currency = state.market === 'cn' ? 'CNY' : 'USD';
  const paging = state.data?.pagination;
  const status = document.getElementById('screenerStatus');
    const demoNote = state.data?.listNote ? `${state.data.listNote} ` : '';
    const staleNote = state.data?.staleNote ? `${state.data.staleNote} ` : '';
    const deduped = state.data?.dedupedSymbolCount != null
      ? `去重 ${state.data.dedupedSymbolCount} 只${state.data.mentionCount && state.data.mentionCount !== state.data.dedupedSymbolCount ? `（名单出现 ${state.data.mentionCount} 次）` : ''}。 `
      : '';
  if (state.loading && !state.data) {
    status.textContent = '正在加载公开行情与财报。';
    document.getElementById('universeTable').innerHTML = '<p class="empty">正在加载观察池。</p>';
    document.getElementById('screenerPager').innerHTML = '';
    return;
  }
  if (state.data?.error || state.data?.detail) {
    status.textContent = `${demoNote}${staleNote}${deduped}${state.data.detail || state.data.error}`;
  } else if (state.data?.partial) {
    status.textContent = `${demoNote}${staleNote}${deduped}部分数据源暂时不可用，下面显示已成功获取的公司。`;
  } else {
    status.textContent = paging
      ? `${demoNote}${staleNote}${deduped}${state.data.activeWatchlist?.title || ''}：本页 ${state.data.stocks.length} 只，序号 ${paging.start}–${paging.end}，总计 ${paging.total} 只。${state.loading ? ' 刷新中…' : ''}`
      : `${demoNote}${staleNote}${deduped}`;
  }
  if (!stocks.length) {
    document.getElementById('universeTable').innerHTML = `<p class="empty">${state.search ? `没有找到“${escapeHtml(state.search)}”。` : '当前页没有股票满足这个筛选。'}</p>`;
  } else {
    document.getElementById('universeTable').innerHTML = `<table>
      <thead><tr>
        <th>#</th><th>代码</th><th>公司</th><th class="num">现价</th>
        <th class="num">${state.market === 'cn' ? '估值参考' : '合理价值'}</th>
        <th class="num">机会</th><th class="num">安全边际</th><th>状态</th><th></th>
      </tr></thead>
      <tbody>${stocks.map((stock, index) => `
        <tr>
          <td class="num">${stock.sourceOrder ?? index + 1}</td>
          <td class="sym-cell">${escapeHtml(stock.symbol)}</td>
          <td>${escapeHtml(stock.company)}<div class="muted">${escapeHtml(SECTOR_ZH[stock.sector] ?? stock.sector ?? '')}</div></td>
          <td class="num">${money(stock.price, currency)}<div class="muted ${stock.dailyChange >= 0 ? 'pos' : 'neg'}">${signedPct(stock.dailyChange)}</div></td>
          <td class="num">${money(stock.fairValue, currency)}${stock.valueLabel ? `<div class="muted">${escapeHtml(stock.valueLabel)}</div>` : ''}</td>
          <td class="num">${stock.opportunityScore ?? '—'}</td>
          <td class="num ${stock.marginOfSafety >= 0 ? 'pos' : 'neg'}">${signedPct(stock.marginOfSafety)}</td>
          <td><span class="status-pill ${statusClass(stock.status)}">${escapeHtml(STATUS_ZH[stock.status] ?? stock.status)}</span></td>
          <td><button type="button" class="text-btn" data-research="${escapeHtml(stock.symbol)}">查看</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  }
  if (paging?.totalPages > 1) {
    document.getElementById('screenerPager').innerHTML = `
      <span>第 ${paging.page} / ${paging.totalPages} 页</span>
      <div>
        <button type="button" class="text-btn" data-page="${Math.max(1, paging.page - 1)}" ${paging.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button type="button" class="text-btn" data-page="${Math.min(paging.totalPages, paging.page + 1)}" ${paging.page >= paging.totalPages ? 'disabled' : ''}>下一页</button>
      </div>`;
  } else {
    document.getElementById('screenerPager').innerHTML = '';
  }
}

function metric(label, value, note = '') {
  return `<div class="research-metric"><span>${escapeHtml(label)}</span><strong>${value}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
}

function historyBars(history, field, currency) {
  const usable = (history ?? []).filter((item) => item[field] != null);
  if (!usable.length) return '<p class="empty">暂无年度序列。</p>';
  const max = Math.max(...usable.map((item) => Math.abs(item[field])), 1);
  return `<div class="history-chart">${usable.map((item) => {
    const height = Math.max(8, Math.abs(item[field]) / max * 100);
    return `<div class="history-column"><div class="bar-track"><span class="bar ${item[field] < 0 ? 'neg' : ''}" style="height:${height}%"></span></div><strong>${compact(item[field], currency)}</strong><span>${escapeHtml(item.period?.slice(0, 4) || '')}</span></div>`;
  }).join('')}</div>`;
}

function renderDrawer() {
  const layer = document.getElementById('researchDrawer');
  const stock = state.research;
  if (!stock) {
    drawerRequest += 1;
    layer.hidden = true;
    layer.innerHTML = '';
    drawerOpener?.focus();
    return;
  }
  const currency = stock.currency === 'CNY' ? 'CNY' : 'USD';
  const { growth, wacc, terminalGrowth } = state.assumptions;
  const dcfValue = calculateResearchDcf(stock, growth, wacc, terminalGrowth);
  const scenarioInputs = stock.valuationModel?.scenarioInputs;
  const scenarios = stock.valuationModel?.scenarios ?? {
    bear: stock.fairValue ? stock.fairValue * 0.78 : null,
    base: stock.fairValue,
    bull: stock.fairValue ? stock.fairValue * 1.25 : null
  };
  const history = stock.financialHistory ?? [];
  const supports = [
    stock.freeCashFlow > 0 && '最新年度自由现金流为正',
    stock.revenueGrowth > 0 && `营收同比增长 ${signedPct(stock.revenueGrowth)}`,
    stock.netMargin > 15 && `净利率达到 ${signedPct(stock.netMargin)}`,
    stock.marginOfSafety > 10 && `现价相对模型价值有 ${signedPct(stock.marginOfSafety)} 的空间`
  ].filter(Boolean);
  const checks = [
    stock.valuationModel?.impliedGrowth != null && `现价隐含约 ${formatNumber(stock.valuationModel.impliedGrowth, 1)}% 的五年现金流增长`,
    stock.debtToEquity > 1 && `债务/权益为 ${formatNumber(stock.debtToEquity)}，需要核对偿债结构`,
    stock.marginOfSafety < 0 && `当前价格高于模型合理价值 ${signedPct(Math.abs(stock.marginOfSafety))}`,
    '模型未纳入最新管理层指引与定性新闻'
  ].filter(Boolean);
  const sensitivityGrowth = [-4, -2, 0, 2, 4].map((offset) => growth + offset);
  const sensitivityWacc = [-2, -1, 0, 1, 2].map((offset) => Math.max(4, wacc + offset));
  layer.hidden = false;
  layer.innerHTML = `
    <article class="research-workspace" role="dialog" aria-modal="true" aria-labelledby="researchTitle">
      <header class="research-topbar">
        <div>
          <p class="kicker">个股研究 · 估值 / 周期 / 价位</p>
          <h2 id="researchTitle">${escapeHtml(stock.symbol)} <small>${escapeHtml(stock.company)}</small></h2>
          <p class="muted">${escapeHtml(SECTOR_ZH[stock.sector] ?? stock.sector ?? '')} · 财务截至 ${formatDate(stock.fiscalDate)}</p>
        </div>
        <div class="research-live-price">
          <span>估值资料参考价</span>
          <strong>${money(stock.price, currency)}</strong>
          <small class="${stock.dailyChange >= 0 ? 'pos' : 'neg'}">${signedPct(stock.dailyChange)}</small>
        </div>
        <button type="button" class="text-btn" id="researchClose">关闭</button>
      </header>
      <div class="research-scroll">
        ${observationHtml(stock.observation)}
        <section class="research-hero">
          <div>
            <span class="status-pill ${statusClass(stock.status)}">${escapeHtml(stock.status === 'Loading data' ? '暂无估值资料' : STATUS_ZH[stock.status] ?? stock.status ?? '暂无估值资料')}</span>
            <h3>${stock.fairValue ? `模型基准价值 ${money(stock.fairValue, currency)}` : '当前数据不足以形成可靠估值'}</h3>
            <p class="muted">${escapeHtml(stock.valuationModel?.note || stock.catalyst || '')}</p>
            <p>机会 ${stock.opportunityScore ?? '—'} · 质量 ${stock.qualityScore ?? '—'} · 风险 ${escapeHtml(RISK_ZH[stock.risk] ?? stock.risk ?? '未评级')} · 置信度 ${escapeHtml(CONFIDENCE_ZH[stock.confidence] ?? stock.confidence ?? '暂无数据')}</p>
            ${!stock.valuationModel ? '<p class="muted">未载入这只股票的估值资料，不能据此形成估值结论。下方行情与周期单独读取。</p>' : ''}
          </div>
          <div class="fair-value-hero">
            <span>基准价值</span>
            <strong>${money(stock.fairValue, currency)}</strong>
            <div>现价 ${money(stock.price, currency)} · 安全边际 <b class="${stock.marginOfSafety >= 0 ? 'pos' : 'neg'}">${signedPct(stock.marginOfSafety)}</b></div>
          </div>
        </section>
        <section class="sheet research-levels">
          <p class="kicker">Cycle + Levels</p>
          <h3>最新可用日线与价位图 · 非实时</h3>
          <button type="button" class="text-btn" id="researchRetry">重新读取周期与价位图</button>
          <div id="researchCycle" class="research-cycle">正在读取周期…</div>
          <div id="researchPoster" class="poster-frame research-poster">正在拉日线…</div>
        </section>
        <section class="scenario-strip">
          ${[
            ['悲观', scenarios.bear],
            ['基准', scenarios.base],
            ['乐观', scenarios.bull],
            scenarioInputs?.multiYearBullTarget != null ? [`${scenarioInputs.multiYearYears || 5} 年目标`, scenarioInputs.multiYearBullTarget] : null
          ].filter(Boolean).map(([label, value]) => `<div><span>${label}</span><strong>${money(value, currency)}</strong></div>`).join('')}
        </section>
        <div class="thesis-grid">
          <article class="sheet"><p class="kicker">Support</p><h3>支持证据</h3><ul>${(supports.length ? supports : ['当前没有足够明确的量化支持信号']).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article>
          <article class="sheet"><p class="kicker">Verify</p><h3>还需要验证</h3><ul>${checks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article>
        </div>
        ${stock.fcfPerShare > 0 ? `
        <section class="sheet">
          <p class="kicker">DCF Cross-check</p>
          <h3>现金流交叉验证</h3>
          <p class="muted">只改变 DCF，不改写上方 EPS × 市盈率形成的今日合理价值。</p>
          <label>前五年 FCF 增长 <b>${formatNumber(growth, 1)}%</b><input id="dcfGrowth" type="range" min="-10" max="35" step="0.5" value="${growth}"></label>
          <label>折现率 WACC <b>${formatNumber(wacc, 1)}%</b><input id="dcfWacc" type="range" min="6" max="15" step="0.25" value="${wacc}"></label>
          <label>永续增长 <b>${formatNumber(terminalGrowth, 1)}%</b><input id="dcfTerminal" type="range" min="0" max="4" step="0.25" value="${terminalGrowth}"></label>
          <div class="key-metric-grid">
            ${metric('可调 DCF', money(dcfValue, currency), '仅作压力测试')}
            ${metric('现金流倍数锚点', money(stock.cashFlowValue, currency))}
            ${metric('净负债/股', money(stock.netDebtPerShare, currency))}
            ${metric('今日基准价值', money(stock.fairValue, currency))}
          </div>
          <div class="table-wrap">
            <table class="sensitivity-table">
              <thead><tr><th>WACC / 增长</th>${sensitivityGrowth.map((item) => `<th>${formatNumber(item, 1)}%</th>`).join('')}</tr></thead>
              <tbody>${sensitivityWacc.map((rate) => `<tr><th>${formatNumber(rate, 1)}%</th>${sensitivityGrowth.map((item) => {
                const value = calculateResearchDcf(stock, item, rate, terminalGrowth);
                return `<td class="${value > stock.price ? 'pos' : 'neg'}">${money(value, currency)}</td>`;
              }).join('')}</tr>`).join('')}</tbody>
            </table>
          </div>
        </section>` : ''}
        <section class="sheet">
          <p class="kicker">Financials</p>
          <h3>历史财务</h3>
          <div class="chart-grid">
            <div><h4>营收</h4>${historyBars(history, 'revenue', currency)}</div>
            <div><h4>自由现金流</h4>${historyBars(history, 'freeCashFlow', currency)}</div>
          </div>
          ${history.length ? `<div class="table-wrap"><table>
            <thead><tr><th>财年</th><th>营收</th><th>净利润</th><th>自由现金流</th><th>EPS</th></tr></thead>
            <tbody>${history.map((item) => `<tr>
              <td>${escapeHtml(item.period?.slice(0, 4) || '')}</td>
              <td class="num">${compact(item.revenue, currency)}</td>
              <td class="num">${compact(item.netIncome, currency)}</td>
              <td class="num ${item.freeCashFlow >= 0 ? 'pos' : 'neg'}">${compact(item.freeCashFlow, currency)}</td>
              <td class="num">${money(item.eps, currency)}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : ''}
          <div class="key-metric-grid">
            ${metric('营收增长', signedPct(stock.revenueGrowth))}
            ${metric('净利率', signedPct(stock.netMargin))}
            ${metric('FCF 利润率', signedPct(stock.fcfMargin))}
            ${metric('ROE', signedPct(stock.roe))}
            ${metric('流动比率', formatNumber(stock.currentRatio))}
            ${metric('债务/权益', formatNumber(stock.debtToEquity))}
            ${metric('股息率', signedPct(stock.dividendYield))}
            ${metric('市值', compact(stock.marketCap, currency))}
          </div>
        </section>
        <p class="muted">这是研究模型，不是目标价或买卖建议。财务：${stock.market === 'cn' ? '东方财富公开年报' : 'SEC EDGAR'}；行情：${escapeHtml(stock.quoteSource || (stock.market === 'cn' ? '东方财富' : 'Nasdaq'))}。价位图不写进推荐/模拟/实际操作。</p>
      </div>
    </article>`;
  loadDetailExtras(stock);
}

async function loadDetailExtras(stock) {
  const cycleEl = document.getElementById('researchCycle');
  const posterEl = document.getElementById('researchPoster');
  if (!cycleEl || !posterEl) return;
  const token = stock.symbol;
  const request = ++drawerRequest;
  if (stock.market === 'cn') {
    cycleEl.innerHTML = '<p class="muted">A股详情走估值实验室。美股 Cycle / 价位图不套用。</p>';
    posterEl.innerHTML = '';
    return;
  }
  cycleEl.textContent = '正在读价格周期…';
  posterEl.innerHTML = '<p class="muted">正在拉日线画 R1/R2/S1/S2…</p>';
  const get = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const current = () => request === drawerRequest && state.research === stock;
  const failure = (el, error) => { if (current()) el.textContent = `读取失败：${error.message}。可点击上方按钮重试。`; };
  await Promise.allSettled([
  get(`/api/cycle?symbol=${encodeURIComponent(token)}`).then(cycle => {
  if (!current()) return;
  if (cycle?.ok) {
    cycleEl.innerHTML = `${stock.observation?.row?.stage && stock.observation.row.stage !== cycle.stage ? `<p class="observation-context">信号已变化：${escapeHtml(stock.observation.row.stageLabel || stock.observation.row.stage)} → ${escapeHtml(cycle.stageLabel || cycle.stage)}。请分别核对观察日与最新日线日期。</p>` : ''}<p class="muted">最新可用日线：${validDate(cycle.signalDate) || '日期未知'} · 版本 ${escapeHtml(versionLabel(cycle.version))} · 日线参考价 ${money(cycle.last)}</p><dl>
      <div><dt>阶段</dt><dd>${escapeHtml(cycle.stageLabel || '—')}</dd></div>
      <div><dt>当前版本精选次日命中</dt><dd>${cycle.versionWinRate?.n ? `${cycle.versionWinRate.rate}%（${cycle.versionWinRate.hits}/${cycle.versionWinRate.n}）` : cycle.version ? '本版命中率待结算' : '版本未知，未合并历史命中率'}</dd></div>
      <div><dt>分数</dt><dd>${cycle.score ?? '—'}</dd></div>
      <div><dt>大盘</dt><dd>${escapeHtml(cycle.regimeLabel || cycle.regime || '—')}</dd></div>
      <div><dt>RS20</dt><dd>${cycle.rs20 == null ? '—' : `${cycle.rs20 >= 0 ? '+' : ''}${cycle.rs20}`}</dd></div>
      <div><dt>ATR</dt><dd>${money(cycle.atr)} ${cycle.atrPct == null ? '' : `（${formatNumber(cycle.atrPct)}%）`}</dd></div>
      <div><dt>失效</dt><dd>${money(cycle.stop)}</dd></div>
    </dl><p class="muted">${escapeHtml(cycle.note || '')}</p>`;
  } else {
    cycleEl.innerHTML = `<p class="muted">${escapeHtml(cycle?.note || cycle?.error || 'DATA UNAVAILABLE')}</p>`;
  }
  }).catch(error => failure(cycleEl, error)),
  get(`/api/posters?symbol=${encodeURIComponent(token)}${stock.observation ? '&view=research' : ''}`).then(poster => {
  if (!current()) return;
  const card = poster?.cards?.[0];
  if (card?.html) posterEl.innerHTML = card.html;
  else posterEl.innerHTML = `<p class="muted">${escapeHtml(poster?.error || card?.error || '这只没有日线价位图。')}</p>`;
  }).catch(error => failure(posterEl, error))
  ]);
}

export function openSymbolDetail(symbol, stock) {
  initScreener();
  const key = String(symbol || '').toUpperCase();
  if (!key) return;
  const isCn = stock?.market === 'cn' || /^\d{6}$/.test(key);
  const found = stock?.fairValue != null || stock?.valuationModel
    ? stock
    : (state.data?.stocks || []).find((row) => row.symbol === key) || stock;
  drawerOpener = document.activeElement;
  state.research = {
    symbol: key,
    company: stock?.company || key,
    market: isCn ? 'cn' : 'us',
    currency: isCn ? 'CNY' : 'USD',
    price: stock?.price ?? stock?.last ?? null,
    dailyChange: stock?.dailyChange ?? stock?.changePct ?? null,
    status: 'Model unavailable',
    sector: '',
    fiscalDate: null,
    ...found,
    observation: stock?.observation || null
  };
  if (!state.research.symbol) state.research.symbol = key;
  state.assumptions = {
    growth: state.research.valuationModel?.assumptions?.growth ?? 6,
    wacc: state.research.valuationModel?.assumptions?.wacc ?? 9,
    terminalGrowth: state.research.valuationModel?.assumptions?.terminalGrowth ?? 2.5
  };
  renderDrawer();
  document.getElementById('researchClose')?.focus();
}

async function loadScreener({ force = false } = {}) {
  state.loading = true;
  renderChrome();
  renderTable();
  const params = new URLSearchParams({
    market: state.market,
    watchlist: state.watchlistId,
    preset: state.presetId,
    page: String(state.page),
    pageSize: String(state.pageSize)
  });
  if (force) params.set('refresh', '1');
  try {
    const response = await fetch(`/api/stocks?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || '观察池数据失败');
    state.data = payload;
    if (payload.activeWatchlist?.id) state.watchlistId = payload.activeWatchlist.id;
  } catch (error) {
    state.data = { ...(state.data || {}), error: error.message, detail: error.message, stocks: state.data?.stocks || [] };
  } finally {
    state.loading = false;
    renderChrome();
    renderTable();
  }
}

function bindScreener() {
  document.getElementById('screenerMarket').addEventListener('click', (event) => {
    const market = event.target.closest('[data-market]')?.dataset.market;
    if (!market || market === state.market) return;
    state.market = market;
    state.watchlistId = market === 'cn' ? 'cn-self' : 'kawaii-curated';
    state.presetId = 'all';
    state.page = 1;
    state.data = null;
    loadScreener();
    loadUniverseWatchStrip();
  });
  document.getElementById('listPills').addEventListener('click', (event) => {
    const id = event.target.closest('[data-watchlist]')?.dataset.watchlist;
    if (!id || id === state.watchlistId) return;
    state.watchlistId = id;
    state.presetId = 'all';
    state.page = 1;
    loadScreener();
  });
  document.getElementById('screenerPresets').addEventListener('click', (event) => {
    const id = event.target.closest('[data-preset]')?.dataset.preset;
    if (!id) return;
    state.presetId = id;
    state.page = 1;
    loadScreener();
  });
  document.getElementById('screenerRefreshBtn').addEventListener('click', () => loadScreener({ force: true }));
  document.getElementById('screenerModeledBtn').addEventListener('click', () => {
    state.modeledOnly = !state.modeledOnly;
    renderChrome();
    renderTable();
  });
  document.getElementById('screenerSort').addEventListener('change', (event) => {
    const [key, direction] = event.target.value.split(':');
    state.sort = { key, direction };
    renderTable();
  });
  document.getElementById('screenerPageSize').addEventListener('change', (event) => {
    state.pageSize = Number(event.target.value);
    state.page = 1;
    loadScreener();
  });
  document.getElementById('screenerSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = document.getElementById('screenerSearch').value.trim().toUpperCase();
    state.search = document.getElementById('screenerSearch').value;
    const watchlist = state.data?.watchlists?.find((row) => row.id === state.watchlistId);
    const symbolIndex = watchlist?.symbols?.findIndex((symbol) => symbol === query) ?? -1;
    if (symbolIndex >= 0) {
      const targetPage = Math.floor(symbolIndex / state.pageSize) + 1;
      state.presetId = 'all';
      if (targetPage !== state.page) {
        state.page = targetPage;
        loadScreener();
        return;
      }
    }
    renderTable();
  });
  document.getElementById('screenerSearch').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderTable();
  });
  document.getElementById('screenerPager').addEventListener('click', (event) => {
    const page = Number(event.target.closest('[data-page]')?.dataset.page);
    if (!page || page === state.page) return;
    state.page = page;
    loadScreener();
  });
  document.getElementById('universeTable').addEventListener('click', (event) => {
    const symbol = event.target.closest('[data-research]')?.dataset.research;
    if (!symbol) return;
    const stock = (state.data?.stocks || []).find((row) => row.symbol === symbol);
    if (!stock) return;
    openSymbolDetail(symbol, stock);
  });
  document.getElementById('researchDrawer').addEventListener('click', (event) => {
    if (event.target.id === 'researchRetry' && state.research) loadDetailExtras(state.research);
    if (event.target.id === 'researchClose' || event.target.id === 'researchDrawer') {
      state.research = null;
      renderDrawer();
    }
  });
  document.getElementById('researchDrawer').addEventListener('input', (event) => {
    if (!state.research) return;
    if (event.target.id === 'dcfGrowth') state.assumptions.growth = Number(event.target.value);
    if (event.target.id === 'dcfWacc') state.assumptions.wacc = Number(event.target.value);
    if (event.target.id === 'dcfTerminal') state.assumptions.terminalGrowth = Number(event.target.value);
    if (['dcfGrowth', 'dcfWacc', 'dcfTerminal'].includes(event.target.id)) renderDrawer();
  });
  document.getElementById('screenerSaveBtn').addEventListener('click', () => {
    const name = window.prompt('筛选名称', `${presetLabel(PRESETS.find((row) => row.id === state.presetId) ?? PRESETS[0])}筛选`);
    if (!name?.trim()) return;
    try {
      const saved = JSON.parse(localStorage.getItem('kawaii-screens') || '[]');
      saved.push({
        id: crypto.randomUUID(),
        name: name.trim(),
        presetId: state.presetId,
        watchlistId: state.watchlistId,
        market: state.market,
        createdAt: new Date().toISOString()
      });
      localStorage.setItem('kawaii-screens', JSON.stringify(saved));
      document.getElementById('screenerStatus').textContent = `已保存“${name.trim()}”。`;
    } catch {
      document.getElementById('screenerStatus').textContent = '当前浏览器无法保存筛选条件。';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && state.research) {
      const controls = [...document.querySelectorAll('#researchDrawer button, #researchDrawer a[href], #researchDrawer input, #researchDrawer select, #researchDrawer [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape' && state.research) {
      state.research = null;
      renderDrawer();
    }
  });
}

export function initScreener() {
  if (initScreener.bound) return;
  initScreener.bound = true;
  bindScreener();
  renderChrome();
}

async function loadUniverseWatchStrip() {
  const el = document.getElementById('universeWatchStrip');
  if (!el) return;
  const cn = state.market === 'cn';
  try {
    const pack = await fetch(cn ? '/api/watchlist/cn' : '/api/watchlist').then((r) => r.json());
    const up = pack?.featured?.up || [];
    const down = pack?.featured?.down || [];
    if (!pack?.ok || (!up.length && !down.length)) {
      el.innerHTML = cn
        ? '<p class="muted">A股 list 今日还没有偏多 / 偏空。打开或刷新后会按公开行情生成。</p>'
        : '';
      return;
    }
    const chip = (row, side) => {
      const name = row.company || row.name || '';
      const pct = row.changePct == null ? '' : `${row.changePct >= 0 ? '+' : ''}${Number(row.changePct).toFixed(1)}%`;
      const head = name
        ? `${escapeHtml(row.symbol)}<em>${escapeHtml(name)}</em>`
        : escapeHtml(row.symbol);
      const sub = cn
        ? [row.stageLabel, pct].filter(Boolean).join(' · ')
        : [row.stageLabel || '', row.score ?? '—'].filter(Boolean).join(' · ');
      return `<button type="button" class="watch-mini ${side}" data-open-symbol="${escapeHtml(row.symbol)}">${head}<small>${escapeHtml(sub)}</small></button>`;
    };
    el.innerHTML = `<div><span>${cn ? 'A股偏多' : '今日偏多'}</span>${up.map((row) => chip(row, 'up')).join('')}</div>
      <div><span>${cn ? 'A股偏空' : '今日偏空'}</span>${down.map((row) => chip(row, 'down')).join('')}</div>
      <p class="muted">${cn ? '按 A 股 list 当日涨跌。点代码打开估值详情。完整看板在「每日观察」。' : '点代码打开详情（周期 + 价位图）。完整看板在「每日观察」。'}</p>`;
    el.querySelectorAll('[data-open-symbol]').forEach((btn) => {
      const symbol = btn.dataset.openSymbol;
      const row = [...up, ...down].find((item) => item.symbol === symbol);
      btn.addEventListener('click', () => openSymbolDetail(symbol, cn
        ? { symbol, company: row?.company, market: 'cn', currency: 'CNY', price: row?.last, dailyChange: row?.changePct }
        : undefined));
    });
  } catch {
    el.innerHTML = cn ? '<p class="muted">A股偏多 / 偏空暂时读不到。</p>' : '';
  }
}

export function ensureScreenerLoaded() {
  initScreener();
  if (!state.data && !state.loading) loadScreener();
  loadUniverseWatchStrip();
}
