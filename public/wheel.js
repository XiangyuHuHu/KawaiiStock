const roots = () => [...document.querySelectorAll('[data-wheel-root]')];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(2)}`;
const pct = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
const num = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);

const PHASE = {
  'short-put': '现金担保认沽',
  'long-stock': '持股',
  'covered-call': '备兑认购',
  cash: '现金'
};

const state = { view: null, scanCandidates: null, bound: false };

export function setWheelCandidates(rows) {
  state.scanCandidates = Array.isArray(rows) ? rows : null;
  if (state.view) renderWheel();
}

function candidates() {
  return state.scanCandidates || state.view?.candidates || [];
}

function positions() {
  return Object.values(state.view?.ledger?.positions || {}).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function post(body) {
  const response = await fetch('/api/options/wheel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export async function loadWheel() {
  const response = await fetch('/api/options/wheel', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || '轮证账本读取失败');
  state.view = data;
  renderWheel();
  return data;
}

function renderWheel(message) {
  const view = state.view;
  const ledger = view?.ledger;
  const rows = candidates();
  const book = positions();
  const closed = (ledger?.closedCycles || []).slice(-5).reverse();
  const status = message || view?.warning || view?.note || '纸上轮证。';
  const html = `
    <div class="sheet-head">
      <div>
        <p class="kicker">Wheel · Paper only</p>
        <h3>纸上轮证</h3>
        <p class="muted">卖出现金担保认沽，锁定行权价×100。到期价内指派 100 股，成本 = 行权价 − 已收权利金；再卖高于成本的备兑认购。被行权卖出后回到现金，作废则留下权利金再滚动。和 0A–0H 账本分开。不下真实单。报价是延迟/参考数据。股价下跌时亏损可以大于权利金。</p>
      </div>
      <div class="head-actions">
        <button type="button" class="text-btn" data-wheel-action="reload">刷新</button>
        <button type="button" class="text-btn" data-wheel-action="reset">重置纸上轮证</button>
      </div>
    </div>
    <p class="status-line wheel-status" role="status">${esc(status)}</p>
    <div class="option-overview">
      <div><span>纸上现金 / 锁定</span><strong>${money(ledger?.cash)}</strong><small>锁定 ${money(ledger?.reservedCash)} · 初始 ${money(ledger?.seed)}</small></div>
      <div><span>权益</span><strong>${money(ledger?.equity)}</strong><small>已实现 ${money(ledger?.realizedPnl)} · 未实现 ${money(ledger?.unrealizedPnl)}</small></div>
      <div><span>最大回撤</span><strong>${pct(ledger?.maxDrawdown)}</strong><small>${money(ledger?.maxDrawdownUsd)} · 股价下跌会记在这里</small></div>
      <div><span>权利金年化</span><strong>${pct(view?.annualizedYield)}</strong><small>只按已收权利金，不含下跌亏损</small></div>
    </div>
    <h4>轮证候选</h4>
    <p class="muted">${esc(view?.quoteNote || '延迟/参考报价，不是成交价。')}</p>
    <div class="table-wrap">${rows.length ? `<table><thead><tr><th>代码</th><th>行权价</th><th>权利金</th><th>DTE</th><th>收益率</th><th>年化</th><th>盈亏平衡</th><th>Delta</th><th></th></tr></thead><tbody>
      ${rows.map((row) => `<tr>
        <td>${esc(row.symbol)}<small>${esc(row.name || '')}</small></td>
        <td>${money(row.strike)}</td>
        <td>${money(row.premium)}</td>
        <td>${esc(row.dte ?? '—')}</td>
        <td>${pct(row.yield)}</td>
        <td>${pct(row.annualizedYield)}</td>
        <td>${money(row.breakeven)}</td>
        <td>${num(row.delta, 2)}</td>
        <td><button type="button" class="text-btn" data-wheel-action="open-put" data-symbol="${esc(row.symbol)}" data-strike="${esc(row.strike)}" data-premium="${esc(row.premium)}" data-expiration="${esc(row.expiration || '')}" data-dte="${esc(row.dte ?? '')}" data-delta="${esc(row.delta ?? '')}" data-spot="${esc(row.spot ?? '')}">纸上卖出现金担保认沽</button></td>
      </tr>`).join('')}
    </tbody></table>` : '<p class="empty">还没有轮证候选。每日期权扫描会从观察清单和持仓里找流动认沽：约 0.20–0.30 delta，或行权价不高于近期支撑，7–45 天。</p>'}</div>
    <h4>纸上轮证仓</h4>
    <div class="table-wrap">${book.length ? `<table><thead><tr><th>代码</th><th>阶段</th><th>现价</th><th>合约</th><th>权利金</th><th>指派</th><th>成本</th><th>已实现账本</th><th>未实现</th><th>年化</th><th>结算现价</th><th></th></tr></thead><tbody>
      ${book.map((row) => `<tr data-wheel-symbol="${esc(row.symbol)}">
        <td>${esc(row.symbol)}</td>
        <td>${esc(PHASE[row.phase] || row.phase)}</td>
        <td>${money(row.last)}</td>
        <td>${row.leg ? `${row.leg.side === 'call' ? '购' : '沽'} ${money(row.leg.strike)} · ${esc(row.leg.expiration)}` : '—'}</td>
        <td>${money(row.premiumIncome)}</td>
        <td>${row.assignments || 0}</td>
        <td>${money(row.costBasis)}</td>
        <td>${money(ledger?.realizedPnl)}</td>
        <td>${money(row.unrealizedPnl)}</td>
        <td>${pct(row.annualizedYield)}</td>
        <td><input data-wheel-spot="${esc(row.symbol)}" type="number" min="0" step="0.01" value="${row.last ?? ''}" aria-label="${esc(row.symbol)} 结算现价"></td>
        <td>
          ${row.phase === 'short-put' || row.phase === 'covered-call' ? `<button type="button" class="text-btn" data-wheel-action="settle" data-symbol="${esc(row.symbol)}">到期结算</button> <button type="button" class="text-btn" data-wheel-action="roll" data-symbol="${esc(row.symbol)}">滚动</button>` : ''}
          ${row.phase === 'long-stock' ? `<span class="wheel-call">购 <input data-wheel-call-strike="${esc(row.symbol)}" type="number" min="0" step="0.01" aria-label="备兑行权价"> 权利金 <input data-wheel-call-premium="${esc(row.symbol)}" type="number" min="0" step="0.01" aria-label="备兑权利金"> 到期 <input data-wheel-call-expiration="${esc(row.symbol)}" type="date" aria-label="备兑到期日"><button type="button" class="text-btn" data-wheel-action="open-call" data-symbol="${esc(row.symbol)}">纸上卖出备兑认购</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>` : '<p class="empty">轮证仓是空的。从上面的候选卖出一张纸上认沽，或等扫描列出候选。</p>'}</div>
    ${closed.length ? `<h4>最近结束的轮次</h4><div class="table-wrap"><table><thead><tr><th>代码</th><th>结果</th><th>权利金</th><th>指派</th><th>成本</th><th>年化</th></tr></thead><tbody>
      ${closed.map((row) => `<tr><td>${esc(row.symbol)}</td><td>${esc(row.event === 'called-away' ? '被行权卖出' : '认沽作废')}</td><td>${money(row.premiumIncome)}</td><td>${row.assignments || 0}</td><td>${money(row.costBasis)}</td><td>${pct(row.annualizedYield)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
  `;
  for (const root of roots()) root.innerHTML = html;
}

function spotFor(symbol, source) {
  const field = source?.querySelector?.(`[data-wheel-spot="${symbol}"]`) || document.querySelector(`[data-wheel-spot="${symbol}"]`);
  const value = Number(field?.value);
  return value > 0 ? value : null;
}

async function onClick(event) {
  const button = event.target.closest?.('[data-wheel-action]');
  if (!button || !button.closest('[data-wheel-root]')) return;
  const action = button.dataset.wheelAction;
  const root = button.closest('[data-wheel-root]');
  try {
    if (action === 'reload') {
      renderWheel('正在读取纸上轮证。');
      await loadWheel();
      return;
    }
    if (action === 'reset') {
      if (!window.confirm('清空纸上轮证账本？不会影响 0A–0H，也不会下真实单。')) return;
      state.view = await post({ action: 'reset' });
      renderWheel('纸上轮证已重置。没有下真实单。');
      return;
    }
    if (action === 'open-put') {
      state.view = await post({
        action: 'open',
        side: 'put',
        symbol: button.dataset.symbol,
        strike: Number(button.dataset.strike),
        premium: Number(button.dataset.premium),
        expiration: button.dataset.expiration,
        dte: button.dataset.dte === '' ? null : Number(button.dataset.dte),
        delta: button.dataset.delta === '' ? null : Number(button.dataset.delta),
        spot: button.dataset.spot === '' ? null : Number(button.dataset.spot)
      });
      renderWheel(`${button.dataset.symbol} 已纸上卖出现金担保认沽，锁定行权价×100。没有下真实单。`);
      return;
    }
    if (action === 'settle') {
      const spot = spotFor(button.dataset.symbol, root);
      if (!(spot > 0)) {
        renderWheel('先填写结算现价。');
        return;
      }
      state.view = await post({ action: 'settle', symbol: button.dataset.symbol, spot });
      renderWheel(state.view.warning || `${button.dataset.symbol} 已按现价 ${spot} 做纸上到期结算。`);
      return;
    }
    if (action === 'roll') {
      const symbol = button.dataset.symbol;
      const spot = spotFor(symbol, root);
      if (!(spot > 0)) {
        renderWheel('先填写结算现价，再滚动。');
        return;
      }
      const held = positions().find((row) => row.symbol === symbol);
      const nextPut = held?.phase === 'short-put'
        ? candidates().find((row) => row.symbol === symbol && row.side !== 'call')
        : null;
      state.view = await post({
        action: 'roll',
        symbol,
        spot,
        candidate: nextPut ? {
          side: 'put',
          strike: nextPut.strike,
          premium: nextPut.premium,
          expiration: nextPut.expiration,
          dte: nextPut.dte,
          delta: nextPut.delta
        } : null
      });
      renderWheel(state.view.warning || `${symbol} 已按现价 ${spot} 纸上滚动。没有下真实单。`);
      return;
    }
    if (action === 'open-call') {
      const symbol = button.dataset.symbol;
      const strike = Number(root.querySelector(`[data-wheel-call-strike="${symbol}"]`)?.value);
      const premium = Number(root.querySelector(`[data-wheel-call-premium="${symbol}"]`)?.value);
      const expiration = root.querySelector(`[data-wheel-call-expiration="${symbol}"]`)?.value;
      const spot = spotFor(symbol, root);
      state.view = await post({ action: 'open', side: 'call', symbol, strike, premium, expiration, spot });
      renderWheel(`${symbol} 已纸上卖出备兑认购。行权价须高于成本。没有下真实单。`);
    }
  } catch (error) {
    renderWheel(error.message);
  }
}

export function bindWheelUi() {
  if (state.bound) return;
  state.bound = true;
  document.addEventListener('click', (event) => {
    onClick(event).catch((error) => renderWheel(error.message));
  });
}
