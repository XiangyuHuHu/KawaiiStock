function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
}

function cardHtml(card) {
  const reasons = (card.reasons || []).map((line) => `<li>${esc(line)}</li>`).join('');
  return `<article class="quant-card">
    <p class="kicker">${esc(card.symbol)} · ${esc(card.regime || 'unknown')} · ${esc(card.stage || '—')}</p>
    <h3 class="quant-action">${esc(card.suggestedAction)}</h3>
    <p>趋势 ${card.scores?.trend ?? '—'} · 衰竭 ${card.scores?.exhaustion ?? '—'} · 相对强度 ${card.scores?.relativeStrength ?? '—'}</p>
    <p>追踪止损 ${card.trailingStop ?? '—'} · k ${card.k ?? '—'} · 回吐 ${card.givebackPct ?? '—'}%</p>
    <p class="muted">${esc(card.reentryTrigger || '')}</p>
    <ul>${reasons}</ul>
  </article>`;
}

function renderCards(pack) {
  const root = document.getElementById('quantCards');
  const status = document.getElementById('quantStatus');
  const cards = pack?.cards || [];
  if (!root) return;
  if (!cards.length) {
    root.innerHTML = '<p class="empty">没有决策卡。</p>';
    return;
  }
  const failed = cards.filter((card) => card.marketOk === false).map((card) => card.symbol);
  if (status) {
    status.textContent = failed.length
      ? `已生成 ${cards.length} 张。这些代码没有行情：${failed.join('、')}。`
      : `已生成 ${cards.length} 张。只观察，不下单。`;
  }
  root.innerHTML = cards.map(cardHtml).join('');
}

function renderPaper(book) {
  const status = document.getElementById('quantPaperStatus');
  const summary = document.getElementById('quantPaperSummary');
  const fills = document.getElementById('quantFills');
  if (!status || !summary || !fills) return;
  if (!book || book.empty) {
    status.textContent = '还没有纸上账。可以用 7811 持仓做 Day0。';
    summary.innerHTML = '';
    fills.innerHTML = '';
    return;
  }
  status.textContent = `${book.label || '纸上账'} · 成交 ${book.fills?.length || 0} 笔 · 不下券商单`;
  summary.innerHTML = `<div class="strip">
    <article><span>净值</span><strong>${money(book.nav)}</strong></article>
    <article><span>盈亏</span><strong>${money(book.pnl)}</strong></article>
    <article><span>峰值盈亏</span><strong>${money(book.peakPnl)}</strong></article>
    <article><span>回吐</span><strong>${book.givebackPct ?? 0}%</strong></article>
    <article><span>买入持有</span><strong>${money(book.buyHoldNav)}</strong></article>
    <article><span>现金</span><strong>${money(book.cash)}</strong></article>
  </div>`;
  const rows = book.fills || [];
  fills.innerHTML = rows.length
    ? `<table><thead><tr><th>时间</th><th>代码</th><th>动作</th><th class="num">数量</th><th class="num">研究价</th><th>原因</th><th>状态</th></tr></thead><tbody>${
      rows.map((row) => `<tr>
        <td>${esc(row.at || '')}</td>
        <td class="sym-cell">${esc(row.symbol)}</td>
        <td>${esc(row.action)}</td>
        <td class="num">${row.qty}</td>
        <td class="num">${money(row.price)}</td>
        <td>${esc(row.reason || '')}</td>
        <td>${esc(row.regime || '')} ${esc(row.stage || '')}</td>
      </tr>`).join('')
    }</tbody></table>`
    : '<p class="empty">还没有纸上成交。HOLD 和 NO_TRADE 不记账。</p>';
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const pack = await response.json();
  if (!response.ok) throw new Error(pack.error || `请求失败 ${response.status}`);
  return pack;
}

export async function loadQuantCards() {
  const status = document.getElementById('quantStatus');
  const input = document.getElementById('quantSymbols');
  const symbols = String(input?.value || '').split(/[\s,]+/).filter(Boolean);
  if (status) status.textContent = '正在取日线并生成决策卡。';
  const pack = await postJson(`/api/quant/decision?symbols=${encodeURIComponent(symbols.join(','))}`);
  renderCards(pack);
  return pack;
}

export async function loadQuantPaper() {
  const pack = await postJson('/api/quant/paper');
  renderPaper(pack);
  return pack;
}

export function bindQuantUi() {
  document.getElementById('quantCardBtn')?.addEventListener('click', () => {
    loadQuantCards().catch((error) => {
      const status = document.getElementById('quantStatus');
      if (status) status.textContent = `决策卡失败：${error.message}`;
    });
  });
  document.getElementById('quantSeedBtn')?.addEventListener('click', () => {
    const status = document.getElementById('quantPaperStatus');
    if (status) status.textContent = '正在用 7811 持仓建立 Day0。';
    postJson('/api/quant/paper/seed', {}).then(renderPaper).catch((error) => {
      if (status) status.textContent = `建立纸上账失败：${error.message}`;
    });
  });
  document.getElementById('quantTickBtn')?.addEventListener('click', () => {
    const status = document.getElementById('quantPaperStatus');
    if (status) status.textContent = '正在按决策层用最近收盘价记一天。';
    postJson('/api/quant/paper/tick', { loadMarket: true }).then(renderPaper).catch((error) => {
      if (status) status.textContent = `纸上记账失败：${error.message}`;
    });
  });
}
