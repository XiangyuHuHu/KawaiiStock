const money2 = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
};

const ACCOUNT_LABELS = { main: '主账户', tactical: '战术', agentic: 'Agentic', tape: '观察带' };

function statusLabel(status) {
  return {
    'hit-stop': '触及止损',
    'hit-fail': '触及失效',
    missing: '无券商止损',
    partial: '止损数量不足',
    loose: '止损偏松',
    covered: '止损已挂',
    'manual-ok': '无接口',
    manual: '无接口',
    option: '期权',
    skip: '忽略',
    ok: '正常'
  }[status] || status;
}

function setGuardBrand() {
  const kicker = document.getElementById('brandKicker');
  const title = document.getElementById('brandTitle');
  const sub = document.getElementById('brandSub');
  const pill = document.getElementById('stancePill');
  if (kicker) kicker.textContent = 'Grok · 护栏';
  if (title) title.textContent = '止损 / 未完成订单';
  if (sub) sub.textContent = '战术 ••••3469 和 Agentic ••••7983。未成交止损不是成交。不是下单。';
  if (pill) pill.textContent = 'STOPS';
}

function renderEventCards(items, mountId) {
  const el = document.getElementById(mountId);
  if (!el) return;
  const rows = items || [];
  if (!rows.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="sheet-head"><div><p class="kicker">Events</p><h2>财报 / 到期</h2><p class="muted">持仓和观察带。不是下单。</p></div></div>
    <div class="event-chips">${rows.slice(0, 16).map((row) => `
      <article class="event-chip ${row.kind || 'earnings'}">
        <span>${row.date?.slice(5) || ''} · ${row.timing || ''}</span>
        <strong>${row.symbol}</strong>
        <small>${(row.accounts || []).map((id) => ACCOUNT_LABELS[id] || id).join(' / ')}</small>
      </article>`).join('')}</div>`;
}

export function renderOverviewEvents(pack, accountId) {
  const el = document.getElementById('eventStrip');
  if (!el) return;
  if (pack?.earningsStatus === 'unknown' || pack?.coverage === 'unknown') {
    el.hidden = false;
    el.innerHTML = '<p class="kicker">Events</p><p class="muted">财报日历未知：来源没有返回完整数据，不能当成这十天没有财报。</p>';
    return;
  }
  if (accountId === 'main' || !pack?.items?.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const rows = pack.items.filter((row) => {
    const ids = row.accounts || [];
    return ids.includes(accountId) || ids.includes('tape');
  });
  if (!rows.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const partial = pack.earningsStatus === 'partial' || pack.coverage === 'partial'
    ? '<p class="muted">部分日期没有返回，缺的那些天是未知，不是没有财报。</p>'
    : '';
  el.innerHTML = `<p class="kicker">Events</p>
    <div class="event-chips">${rows.slice(0, 10).map((row) => `
      <article class="event-chip ${row.kind || 'earnings'}">
        <span>${row.date?.slice(5) || ''} · ${row.timing || ''}</span>
        <strong>${row.symbol}</strong>
        <small>${row.kind === 'option-expiry' ? '期权到期' : '财报'}</small>
      </article>`).join('')}</div>
    ${partial}
    <p class="muted">不是下单。完整列表在「止损」。</p>`;
}

function renderGuards(pack) {
  setGuardBrand();
  const status = document.getElementById('guardStatus');
  const strip = document.getElementById('guardStrip');
  const table = document.getElementById('guardTable');
  const orders = document.getElementById('guardOrders');
  const orphans = document.getElementById('guardOrphans');
  const events = document.getElementById('guardEvents');
  if (status) {
    status.textContent = pack.error
      ? pack.error
      : `推荐日 ${pack.recDate || '—'} · 告警 ${pack.counts?.alerts ?? 0} · 缺止损 ${pack.counts?.missingStops ?? 0} · 未完成订单 ${pack.counts?.openOrders ?? 0}。${pack.note || ''}`;
  }
  if (strip) {
    strip.innerHTML = [
      ['告警', pack.counts?.alerts ?? 0],
      ['缺止损', pack.counts?.missingStops ?? 0],
      ['未完成', pack.counts?.openOrders ?? 0],
      ['无持仓挂单', pack.counts?.orphans ?? 0]
    ].map(([k, v]) => `<article><span>${k}</span><strong>${v}</strong></article>`).join('');
  }
  const rows = pack.positions || [];
  if (table) {
    table.innerHTML = rows.length
      ? `<table><thead><tr><th>账户</th><th>代码</th><th>状态</th><th class="num">数量</th><th class="num">现价</th><th class="num">失效价</th><th class="num">券商止损</th><th>备注</th></tr></thead><tbody>${
        rows.map((row) => `<tr class="guard-${row.status}">
          <td>${row.accountLabel || row.accountId}</td>
          <td class="sym-cell">${row.symbol}</td>
          <td><span class="action-tag ${row.severity >= 3 ? 'SELL' : row.severity >= 1 ? 'WAIT' : 'HOLD'}">${statusLabel(row.status)}</span></td>
          <td class="num">${row.qty ?? '—'}</td>
          <td class="num">${money2(row.last)}</td>
          <td class="num">${money2(row.failPrice)}</td>
          <td class="num">${money2(row.stopPrice)}</td>
          <td class="tradable-reason">${row.note || ''}</td>
        </tr>`).join('')
      }</tbody></table>`
      : '<p class="empty">没有可核对的持仓。</p>';
  }
  const open = pack.openOrders || [];
  if (orders) {
    orders.innerHTML = open.length
      ? `<table><thead><tr><th>账户</th><th>代码</th><th>方向</th><th>类型</th><th class="num">数量</th><th class="num">价格</th><th>状态</th><th>止损?</th></tr></thead><tbody>${
        open.map((row) => `<tr>
          <td>${row.accountLabel}</td>
          <td class="sym-cell">${row.symbol}</td>
          <td>${row.side}</td>
          <td>${row.type}</td>
          <td class="num">${row.qty || '—'}</td>
          <td class="num">${money2(row.price ?? row.stopPrice)}</td>
          <td>${row.status}</td>
          <td>${row.isStop ? '是' : '否'}</td>
        </tr>`).join('')
      }</tbody></table>`
      : '<p class="empty">没有未完成订单。confirmed 止损算未完成，不算成交。</p>';
  }
  const leftover = pack.orphans || [];
  if (orphans) {
    orphans.innerHTML = leftover.length
      ? `<table><thead><tr><th>账户</th><th>代码</th><th>类型</th><th class="num">价格</th><th>备注</th></tr></thead><tbody>${
        leftover.map((row) => `<tr>
          <td>${row.accountLabel}</td>
          <td class="sym-cell">${row.symbol}</td>
          <td>${row.type}</td>
          <td class="num">${money2(row.stopPrice ?? row.price)}</td>
          <td>${row.note || ''}</td>
        </tr>`).join('')
      }</tbody></table>`
      : '<p class="empty">没有「持仓已空、订单还挂着」的单。</p>';
  }
  if (events) {
    const el = document.getElementById('guardEvents');
    if (pack.earningsStatus === 'unknown' || pack.coverage === 'unknown') {
      if (el) {
        el.hidden = false;
        el.innerHTML = '<p class="kicker">Events</p><h2>财报 / 到期</h2><p class="muted">财报日历未知：来源没有返回完整数据，不能当成这十天没有财报。</p>';
      }
    } else if (pack.earningsStatus === 'partial' || pack.coverage === 'partial') {
      renderEventCards(pack.events || [], 'guardEvents');
      if (el && !el.hidden) {
        el.insertAdjacentHTML('beforeend', '<p class="muted">部分日期没有返回，缺的那些天是未知，不是没有财报。</p>');
      } else if (el) {
        el.hidden = false;
        el.innerHTML = '<p class="kicker">Events</p><h2>财报 / 到期</h2><p class="muted">财报日历不完整：缺的日期是未知，不能当成这十天没有财报。</p>';
      }
    } else renderEventCards(pack.events || [], 'guardEvents');
  }
}

export async function loadEvents({ refresh = false } = {}) {
  const pack = await fetch(`/api/events${refresh ? '?refresh=1' : ''}`).then((r) => r.json());
  return pack;
}

export async function loadGuards() {
  const status = document.getElementById('guardStatus');
  if (status) status.textContent = '正在核对持仓、失效价和未完成订单。';
  const [guards, events] = await Promise.all([
    fetch('/api/guards').then((r) => r.json()),
    fetch('/api/events').then((r) => r.json()).catch(() => ({ items: [] }))
  ]);
  guards.events = events.items || [];
  renderGuards(guards);
  return guards;
}

export function bindOpsUi() {
  document.getElementById('guardRefreshBtn')?.addEventListener('click', () => {
    loadGuards().catch((error) => {
      const status = document.getElementById('guardStatus');
      if (status) status.textContent = `止损看板失败：${error.message}`;
    });
  });
}
