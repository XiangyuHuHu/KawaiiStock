import { strategyLine } from './strategy-rate.js';

const paperScore = { value: null };

const money = (value, currency = 'USD') => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString(currency === 'CNY' ? 'zh-CN' : 'en-US', { style: 'currency', currency });
};

function etStamp(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const raw = String(value || '');
    return raw ? raw.slice(0, 16).replace('T', ' ') : '—';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ET`;
}

function sideLabel(side) {
  const key = String(side || '').toLowerCase();
  if (key === 'buy' || key === 'add') return '买入';
  if (key === 'trim') return '减仓';
  if (key === 'sell' || key === 'exit' || key === 'close') return '卖出';
  return side || '—';
}

const state = {
  desk: localStorage.getItem('kawaii-paper-desk') || '0b'
};

function setStatus(text) {
  const el = document.getElementById('paperStatus');
  if (el) el.textContent = text;
}

function renderDeskBar(desks = {}) {
  const bar = document.getElementById('paperDeskBar');
  if (!bar) return;
  const rows = Object.values(desks);
  if (!rows.length) {
    rows.push(
      { id: '0a', label: 'Phase 0A · $1M 财富' },
      { id: '0b', label: 'Phase 0B · $50k 进攻' },
      { id: '0c', label: 'Phase 0C · $5k Alpha' },
      { id: '0d', label: 'Phase 0D · $100k 算卦' },
      { id: '0e', label: 'Phase 0E · $100k 期权' },
      { id: '0f', label: 'Phase 0F · $100k Claude 动量' },
      { id: '0g', label: 'Phase 0G · 小孟A股 ¥10万' },
      { id: '0h', label: 'Phase 0H · 小孟美股 $10万' }
    );
  }
  bar.innerHTML = rows.map((row) => (
    `<button type="button" class="account-chip ${row.id === state.desk ? 'is-active' : ''}" data-desk="${row.id}">${row.id.toUpperCase()}<small>${row.label || ''}</small></button>`
  )).join('');
  bar.querySelectorAll('[data-desk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.desk = btn.dataset.desk;
      localStorage.setItem('kawaii-paper-desk', state.desk);
      loadPaper().catch((error) => setStatus(`读取失败：${error.message}`));
    });
  });
}

function renderPaper(data) {
  const ledger = data.ledger || {};
  const cashName = data.desk === '0g' ? 'CNY' : 'USD';
  const show = (value) => money(value, cashName);
  const book = data.book || {};
  const mode = data.mode || book.mode || 'NORMAL';
  if (data.desk) state.desk = data.desk;
  if (data.desks) renderDeskBar(data.desks);
  document.getElementById('paperStrip').innerHTML = [
    [ledger.valuationFresh === false ? '参考净值（报价缺失/过期）' : '净值', show(ledger.nav)],
    ['现金', show(ledger.cash)],
    ['持仓', (ledger.positions || []).length],
    ['成交', (ledger.fills || []).length],
    ['模式', mode]
  ].map(([k, v]) => `<article><span>${k}</span><strong>${v}</strong></article>`).join('');

  const pos = ledger.positions || [];
  const exitKey = (row) => state.desk === '0e'
    ? `${row.symbol}:${row.expiration}:${row.strike}:${row.optionType || row.right}`
    : row.symbol;
  const exits = new Map((data.exits || []).map((row) => [exitKey(row), row]));
  const seeds = { '0a': 1000000, '0b': 50000, '0c': 5000, '0d': 100000, '0e': 100000, '0f': 100000, '0g': 100000, '0h': 100000 };
  const seed = ledger.seed || seeds[state.desk] || 50000;
  document.getElementById('paperBook').innerHTML = pos.length
    ? `<table><thead><tr><th>代码 / 合约</th><th>品种</th><th class="num">数量</th><th class="num">成本</th><th class="num">行情价 / 上次成交价</th><th class="num">止损</th><th>卖出判断</th><th>策略</th></tr></thead><tbody>${
      pos.map((row) => {
        const exit = exits.get(exitKey(row));
        const option = row.instrument === 'option';
        const priceLabel = option
          ? (row.markKind === 'mid' ? `买卖中间价 ${etStamp(row.markedAt)}` : row.markKind === 'last' ? `最新成交 ${row.markedAt ? etStamp(row.markedAt) : ''}`.trim() : '上次成交价')
          : (row.quoteAt ? etStamp(row.quoteAt) : '报价时间缺失');
        const contract = option ? `<small>${String(row.optionType || row.right || '').toUpperCase()} ${row.strike ?? '—'} · 到期 ${row.expiration || '未知'} · 100 股/张</small>` : '';
        return `<tr><td class="sym-cell">${row.symbol}${contract}</td><td>${row.instrument || 'equity'}</td><td class="num">${row.qty}</td><td class="num">${show(row.avgCost)}</td><td class="num">${show(row.last)}<small>${priceLabel}</small></td><td class="num">${row.stopPrice ?? '—'}</td><td>${exit?.label || '—'}</td><td>${strategyLine(row, paperScore.value)}</td></tr>`;
      }).join('')
    }</tbody></table>`
    : `<p class="empty">纸上空仓。起始 ${show(seed)}。0A–0C 按股票推荐。0D 偏涨试买，当日判断为跌就卖。0E 不再按期权扫描开新仓；已有合约跌 20% 平仓，离开研究名单并且涨了 40% 才止盈。0F 全 list 动量排名买前几名，3×ATR 吊灯止损。0G 小孟A股、0H 小孟美股做涨停或大涨后的回调，3–4 只分仓。</p>`;

  const fills = [...(ledger.fills || [])].reverse().slice(0, 20);
  document.getElementById('paperFills').innerHTML = fills.length
    ? `<table><thead><tr><th>成交时间</th><th>方向</th><th>代码 / 合约</th><th class="num">数量</th><th class="num">单价（期权每股权利金）</th><th class="num">已实现盈亏</th><th class="num">止损</th></tr></thead><tbody>${
      fills.map((row) => `<tr><td>${etStamp(row.time || row.date)}</td><td>${sideLabel(row.side)}</td><td class="sym-cell">${row.symbol}${row.instrument === 'option' ? `<small>${String(row.optionType || row.right || '').toUpperCase()} ${row.strike ?? '—'} · 到期 ${row.expiration || '未知'}</small>` : ''}</td><td class="num">${row.qty}</td><td class="num">${show(row.price)}</td><td class="num">${show(row.realizedPnl)}</td><td class="num">${row.stopPrice ?? '—'}</td></tr>`).join('')
    }</tbody></table>`
    : '<p class="empty">还没有纸上成交。</p>';

  const auto = ledger.lastAuto;
  const sources = auto?.sources || null;
  const sourceLine = state.desk === '0d' && sources
    ? `来源：奇门 ${sources.oracleDate || '无'}、观察确认 ${sources.watchDate || '缺失'}、买入推荐 ${sources.recDate || '缺失'}。`
    : state.desk === '0e' && sources
      ? '来源：期权研究台已关闭，本轮只检查已有合约。'
      : state.desk === '0f' && sources
        ? `动量扫描 ${sources.scanned ?? 0} 只，合格 ${sources.eligible ?? 0} 只，大盘 ${sources.regime === 'risk-on' ? '在 200 日线上' : '在 200 日线下，不开新仓'}。前五：${(sources.top || []).slice(0, 5).map((row) => `#${row.rank} ${row.symbol}`).join('、') || '无'}。`
        : (state.desk === '0g' || state.desk === '0h') && sources
          ? `涨停回调扫描 ${sources.scanned ?? 0} 只，买点 ${sources.eligible ?? 0} 个。${sources.l2 || ''}。${(sources.names || []).join('、')}`
          : '';
  const diag = auto?.diagnostics;
  const rejectionText = diag
    ? Object.entries(diag.filterRejections || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason} ×${count}`).join('；')
    : '';
  const diagLine = diag
    ? `诊断：扫描 ${diag.scanned ?? '—'}，成交 ${diag.ordersPlaced ?? 0}${rejectionText ? `，过滤 ${rejectionText}` : ''}。`
    : '';
  const sold = (auto?.reviews || []).filter((row) => row.action === 'SELL' || row.action === 'TRIM');
  const held = (auto?.reviews || []).filter((row) => row.action === 'HOLD');
  const reviewLine = state.desk === '0e'
    ? auto?.reviews?.length ? `上次合约检查 ${sold.length} 笔尝试卖出、${held.length} 笔保留；实际成交看成交栏。` : '期权平仓需要本合约有效 Bid；缺价时待评估。'
    : state.desk === '0f'
      ? auto?.reviews?.length ? `上次动量仓检查 ${sold.length} 笔要卖、${held.length} 笔继续拿。` : '动量仓：跌到吊灯止损、跌破 100 日线或掉出前 20 名才卖。'
      : state.desk === '0g' || state.desk === '0h'
        ? auto?.reviews?.length ? `上次回调仓检查 ${sold.length} 笔要卖、${held.length} 笔继续拿。` : '小孟仓：跌破 10 日线、亏 6%、满 5 天或赚 8% 才清仓。'
    : state.desk === '0d'
      ? auto?.reviews?.length ? `上次算卦仓检查 ${sold.length} 笔尝试卖出、${held.length} 笔保留；实际成交看成交栏。` : '算卦仓卖出判断需本时盘与有效股票报价。'
      : auto?.reviews?.length
        ? `卖出判断 ${sold.length} 笔要卖、${held.length} 笔继续拿。`
        : '卖出判断在持仓表：跌破止损就卖，盈利没到倍数就拿着。';
  const skipLine = (auto?.skips || []).map((row) => row.message || row.reason).filter(Boolean).slice(0, 3).join('；');
  const autoLine = auto
    ? `上次纸上尝试 ${etStamp(auto.at || auto.date)}：成交 ${auto.fillCount ?? 0} · 跳过 ${auto.skipCount ?? 0}。${diagLine}${sourceLine}${skipLine ? `${skipLine}。` : ''}${reviewLine}`
    : `还没运行纸上过闸。${reviewLine}`;
  const valuationLine = ledger.valuationFresh === false ? '估值含过期股票报价或期权历史成交价，不代表当前可卖出净值。' : '';
  setStatus(mode !== 'NORMAL'
    ? `${mode}：${data.modeReason || book.modeReason || ''}。${valuationLine}${autoLine}`
    : `${valuationLine}${autoLine} ${data.note || ''}`);
}

export async function loadPaper() {
  setStatus('正在读取纸上实验仓。');
  const [data, score] = await Promise.all([
    fetch(`/api/paper?desk=${encodeURIComponent(state.desk)}`).then((r) => r.json()),
    paperScore.value
      ? Promise.resolve(paperScore.value)
      : fetch('/api/watch-score').then((r) => r.json()).catch(() => null)
  ]);
  if (score?.ok) paperScore.value = score;
  renderPaper(data);
  return data;
}

async function submitPaper(event) {
  event.preventDefault();
  const body = {
    desk: state.desk,
    symbol: document.getElementById('paperSymbol').value.trim().toUpperCase(),
    side: document.getElementById('paperSide').value,
    qty: Number(document.getElementById('paperQty').value),
    limitPrice: Number(document.getElementById('paperLimit').value) || undefined,
    stopPrice: Number(document.getElementById('paperStop').value) || undefined,
    maxLoss: Number(document.getElementById('paperMaxLoss').value) || undefined,
    instrument: document.getElementById('paperInstrument').value,
    theme: document.getElementById('paperTheme').value.trim(),
    note: document.getElementById('paperNote').value.trim() || 'ui'
  };
  setStatus('正在过 Gateway 并记纸上成交。');
  const data = await fetch('/api/paper/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((r) => r.json());
  if (!data.ok) {
    setStatus(`拒绝：${data.decision?.code || ''} ${data.decision?.mode || ''} ${data.decision?.message || data.error || ''}`);
    return data;
  }
  renderPaper({ ...data, ledger: data.ledger, desks: data.desks, note: data.decision?.message });
  setStatus(`成交 ${data.fill?.side} ${data.fill?.symbol} @ ${data.fill?.price}。${data.decision?.message || ''}`);
  return data;
}

async function setPaperMode(mode, confirm = false) {
  const result = await fetch('/api/risk/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      book: `paper-${state.desk}`,
      mode,
      reason: 'ui',
      confirm,
      actor: 'human'
    })
  }).then((r) => r.json());
  if (!result.ok) {
    setStatus(`模式未改：${result.message || result.code}`);
    return result;
  }
  return loadPaper();
}

export function bindPaperUi() {
  document.getElementById('paperForm')?.addEventListener('submit', (event) => {
    submitPaper(event).catch((error) => setStatus(`纸上单失败：${error.message}`));
  });
  document.getElementById('paperRefreshBtn')?.addEventListener('click', () => {
    loadPaper().catch((error) => setStatus(`读取失败：${error.message}`));
  });
  document.getElementById('paperAutoBtn')?.addEventListener('click', () => {
    const button = document.getElementById('paperAutoBtn');
    const summary = document.getElementById('paperRunSummary');
    if (button.disabled) return;
    button.disabled = true;
    if (summary) { summary.hidden = false; summary.textContent = '纸上任务正在运行。'; }
    setStatus('正在自动过闸：0A、0B、0C，然后 0D 算卦、0E 已有期权、0F 动量、0G 小孟A股、0H 小孟美股。');
    fetch('/api/paper/auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: 'all', force: true })
    })
      .then((r) => r.json())
      .then((data) => {
        const sessions = data.sessions || {};
        const line = ['0a', '0b', '0c', '0d', '0e', '0f', '0g', '0h'].map((id) => {
          const row = sessions[id];
          if (!row) return `${id.toUpperCase()} 未跑`;
          if (row.ok === false) return `${id.toUpperCase()} 失败：${row.note || row.skipped?.[0]?.message || row.recordingError || '原因未知'}`;
          return `${id.toUpperCase()} 成交 ${row.fills?.length ?? 0} / 跳过 ${row.skipped?.length ?? 0}`;
        }).join(' · ');
        if (summary) summary.textContent = `${data.ok === false ? '纸上任务部分失败' : '纸上任务已返回'}：${line}。${data.note || ''}`;
        return loadPaper();
      })
      .catch((error) => { if (summary) summary.textContent = `纸上任务失败：${error.message}`; })
      .finally(() => { button.disabled = false; });
  });
  document.getElementById('paperResetBtn')?.addEventListener('click', () => {
    const seed = { '0a': '$1,000,000', '0b': '$50,000', '0c': '$5,000', '0d': '$100,000', '0e': '$100,000', '0f': '$100,000', '0g': '¥100,000', '0h': '$100,000' }[state.desk] || '$50,000';
    if (!window.confirm(`重置 ${state.desk.toUpperCase()} 到 ${seed} 空仓？不影响另一本纸上账、模拟操作和实盘。`)) return;
    fetch(`/api/paper/reset?desk=${encodeURIComponent(state.desk)}`, { method: 'POST' })
      .then(() => loadPaper())
      .catch((error) => setStatus(`重置失败：${error.message}`));
  });
  document.getElementById('paperReduceBtn')?.addEventListener('click', () => {
    setPaperMode('REDUCE_ONLY').catch((error) => setStatus(error.message));
  });
  document.getElementById('paperProtectBtn')?.addEventListener('click', () => {
    setPaperMode('PROTECT').catch((error) => setStatus(error.message));
  });
  document.getElementById('paperKillBtn')?.addEventListener('click', () => {
    if (!window.confirm(`锁定 ${state.desk.toUpperCase()} 为 KILL？恢复必须再确认。`)) return;
    setPaperMode('KILL').catch((error) => setStatus(error.message));
  });
  document.getElementById('paperResumeBtn')?.addEventListener('click', () => {
    if (!window.confirm('确认把模式恢复成 NORMAL？这是人工动作，AI 不得代点。')) return;
    setPaperMode('NORMAL', true).catch((error) => setStatus(error.message));
  });
}
