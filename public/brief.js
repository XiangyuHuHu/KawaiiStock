const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lean = (value) => ({ up: '偏涨', down: '偏跌', trim: '减仓', hold: '持有', wait: '观望', split: '分歧', none: '无' }[value] || '无');

function setStatus(text) {
  const el = document.getElementById('briefStatus');
  if (el) el.textContent = text;
}

function list(title, rows) {
  if (!rows?.length) return '';
  return `<section><h3>${esc(title)}</h3><ul class="action-list">${rows.map((row) => `<li><strong>${esc(row.action)} ${esc(row.symbol)}</strong><span>${esc(row.stageLabel || '')}${row.score != null ? ` · ${row.score}分` : ''}</span><small>观察 ${lean(row.watch)} · 推荐 ${lean(row.rec)} · 期权 ${lean(row.option)}${row.optionEligible ? '合格' : ''} · 算卦 ${lean(row.oracle)}</small><p>${esc(row.reason)}</p></li>`).join('')}</ul></section>`;
}

function renderBrief(pack) {
  const title = document.getElementById('briefHeadline');
  const body = document.getElementById('briefBody');
  if (!title || !body) return;
  if (!pack || pack.empty || pack.ok === false) {
    title.textContent = '还没有 Agentic 操作意见';
    body.innerHTML = `<p class="empty">${esc(pack?.note || pack?.error || '每日任务跑完后会出现。')}</p>`;
    return;
  }
  title.textContent = pack.headline || 'Agentic 操作意见';
  const a = pack.actions || {};
  body.innerHTML = `
    <p class="muted">观察日 ${esc(pack.date)} · 持仓快照 ${esc(pack.holdings?.asOf || '未知')}${pack.holdings?.stale ? ' · 不是今天' : ''} · ${esc(pack.stance)} · 不是订单</p>
    ${list('先处理', a.exit)}
    ${list('减仓', a.trim)}
    ${list('现仓', a.hold)}
    ${list('先核对持仓', a.review)}
    ${list('可研究新开', a.consider)}
    ${list('观察池对齐但今天不开', a.watch)}
    <p class="muted">${esc(pack.note)}</p>
  `;
}

export async function loadBrief({ write = false } = {}) {
  setStatus(write ? '正在按已保存的观察 / 算卦 / 期权 / 推荐重算…' : '正在读取 Agentic 操作意见…');
  try {
    const response = await fetch(write ? '/api/agentic-brief/run' : '/api/agentic-brief', { method: write ? 'POST' : 'GET', cache: 'no-store', headers: write ? { 'Content-Type': 'application/json' } : undefined, body: write ? '{}' : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    renderBrief(data);
    setStatus(data.empty ? (data.note || '还没有意见。') : `已生成 ${data.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) : data.date}。未授权不下单。`);
    return data;
  } catch (error) {
    setStatus(`读取失败：${error.message}`);
    throw error;
  }
}

export function bindBriefUi() {
  document.getElementById('briefRefreshBtn')?.addEventListener('click', () => {
    loadBrief({ write: true }).catch((error) => setStatus(`重算失败：${error.message}`));
  });
}
