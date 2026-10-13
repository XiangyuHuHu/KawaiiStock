let posterState = { pack: null, symbol: null };

function posterRoot() {
  return {
    status: document.getElementById('posterStatus'),
    chips: document.getElementById('posterChips'),
    overview: document.getElementById('posterOverview'),
    frame: document.getElementById('posterFrame')
  };
}

function renderPosterPack(pack, symbol) {
  const ui = posterRoot();
  if (!ui.frame) return;
  posterState = { pack, symbol };
  const cards = pack.cards || [];
  const current = cards.find((row) => row.symbol === symbol) || cards.find((row) => row.ok) || cards[0];
  ui.chips.innerHTML = cards.map((row) => (
    `<button type="button" class="${row.symbol === current?.symbol ? 'is-active' : ''}" data-symbol="${row.symbol}">${row.symbol}${row.ok ? '' : '!'}</button>`
  )).join('');
  ui.chips.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => renderPosterPack(pack, btn.dataset.symbol));
  });
  const okCount = cards.filter((row) => row.ok).length;
  ui.status.textContent = `${pack.accountLabel} · ${pack.date} · 算出 ${okCount}/${cards.length} 只。价位图不写进推荐/模拟/实际操作。`;
  ui.overview.innerHTML = pack.overviewHtml || '';
  if (current?.html) ui.frame.innerHTML = current.html;
  else ui.frame.innerHTML = `<p class="poster-empty">${current?.error || '这只没有日线。'}</p>`;
}

export async function loadPosters() {
  const ui = posterRoot();
  if (!ui.status) return;
  const desk = localStorage.getItem('kawaii-desk') || 'grok';
  const account = localStorage.getItem('kawaii-account') || 'main';
  ui.status.textContent = `正在拉 ${account} 日线并计算 R/S，不会下单。`;
  const res = await fetch(`/api/posters?desk=${encodeURIComponent(desk)}&account=${encodeURIComponent(account)}`);
  const pack = await res.json();
  if (pack.error || !pack.ok) {
    ui.status.textContent = `价位图失败：${pack.error || pack.message || '未知错误'}`;
    return;
  }
  renderPosterPack(pack, posterState.symbol);
}

export async function runPosters() {
  const ui = posterRoot();
  const desk = localStorage.getItem('kawaii-desk') || 'grok';
  const account = localStorage.getItem('kawaii-account') || 'main';
  ui.status.textContent = '正在生成并写入价位图文件夹。不改持仓、不下单。';
  const res = await fetch(`/api/posters/run?desk=${encodeURIComponent(desk)}&account=${encodeURIComponent(account)}`, { method: 'POST' });
  const pack = await res.json();
  if (pack.error || !pack.ok) {
    ui.status.textContent = `写入失败：${pack.error || pack.message || '未知错误'}`;
    return;
  }
  renderPosterPack(pack, posterState.symbol);
  ui.status.textContent = `已写入 ${pack.written?.dir || '价位图/'}，${pack.written?.count ?? 0} 张。浏览器打印即可出长图。`;
}
