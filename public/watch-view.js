export const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export const BOARD_LABELS = { confluence: '共振确认', setups: '周期观察', volume: '量能扩张', rs: '相对强度', avoid: '避开观察', surge: '大涨', drop: '大跌', turnover: '高换手', cheap: '低 PE' };

export const WATCH_FILTERS = [
  ['all', '全部候选'], ['early-swing', 'Early Swing'], ['breakout', 'Breakout'],
  ['momentum', 'Momentum'], ['volume-expansion', '量能扩张'], ['breakdown', '结构下破']
];

export function matchesWatchFilter(row, filter) {
  if (filter === 'all') return true;
  if (filter === 'early-swing') return row.stage === 'ema-crossback' && row.watch === true;
  if (filter === 'breakout') return ['wedge-pop', 'base-n-break'].includes(row.stage);
  if (filter === 'momentum') return ['wedge-pop', 'ema-crossback', 'base-n-break'].includes(row.stage)
    && row.rs20 != null && Number.isFinite(Number(row.rs20)) && Number(row.rs20) >= 5;
  if (filter === 'volume-expansion') return row.volumeRatio != null && Number.isFinite(Number(row.volumeRatio)) && Number(row.volumeRatio) >= 1.5;
  if (filter === 'breakdown') return row.stage === 'wedge-drop';
  return false;
}

export function versionLabel(version) {
  const match = /^cycle-v2-confirmed-(\d{4})(\d{2})(\d{2})$/.exec(version || '');
  return match ? `V2 收盘确认（${match[1]}-${match[2]}-${match[3]} 版）` : version || '未知';
}

export function uniqueWatchRows(pack) {
  const rows = new Map();
  const add = (row, tag, featured = false) => {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    if (!symbol) return;
    if (!rows.has(symbol)) rows.set(symbol, { ...row, symbol, tags: [], featured });
    const saved = rows.get(symbol);
    if (!saved.tags.includes(tag)) saved.tags.push(tag);
  };
  for (const side of ['up', 'down']) for (const row of pack?.featured?.[side] || []) add(row, side === 'up' ? '偏多精选' : '偏空精选', true);
  for (const [key, list] of Object.entries(pack?.boards || {})) for (const row of list || []) add(row, BOARD_LABELS[key] || key);
  return [...rows.values()].sort((a, b) => Number(b.allowNewLong === true) - Number(a.allowNewLong === true));
}

export function watchFreshness(pack, market = 'us', now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: market === 'cn' ? 'Asia/Shanghai' : 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const target = today;
  const observation = validDate(pack?.date);
  const rows = uniqueWatchRows(pack);
  const reasons = [];
  if (!observation) reasons.push('观察日期缺失');
  else if (observation < target) reasons.push(`观察快照 ${observation} 落后于当前观察日 ${target}`);
  else if (observation > target) reasons.push('观察日期晚于当前观察日，需核对');
  const source = (key, label) => {
    const dates = rows.map(row => validDate(row[key]));
    const known = dates.filter(Boolean).sort();
    const missing = dates.length - known.length;
    if (!known.length) reasons.push(`${label}日期缺失`);
    else {
      if (missing) reasons.push(`${missing} 只股票缺少${label}日期`);
      if (known[0] < target) reasons.push(`${label}包含 ${known[0]} 的旧数据`);
      if (known.at(-1) > target) reasons.push(`${label}日期晚于当前观察日，需核对`);
    }
    return { latest: known.at(-1) || null, earliest: known[0] || null, missing };
  };
  const price = source('priceDate', '行情');
  const signal = market === 'us' ? source('signalDate', '日线信号') : null;
  if (pack?.stale && !reasons.length) reasons.push('来源已标记为过期');
  if (pack?.listError) reasons.push(`观察清单异常：${pack.listError}`);
  return { target, observation, price, signal, reasons, stale: reasons.length > 0 };
}

export function freshnessHtml(pack, market, now) {
  const data = watchFreshness(pack, market, now);
  const stamp = (source) => `${source.latest || '未知'}${source.earliest && source.earliest !== source.latest ? `（最早 ${source.earliest}）` : ''}`;
  const generated = pack?.generatedAt && Number.isFinite(new Date(pack.generatedAt).getTime()) ? new Date(pack.generatedAt).toLocaleString('zh-CN') : '未知';
  return `<div class="watch-freshness ${data.stale ? 'is-stale' : ''}" role="status"><strong>${data.stale ? '非实时 / 已过期或日期不完整' : '非实时 · 已保存观察快照'}</strong>
    <p>当前观察日 ${escapeHtml(data.target)} · 快照 ${data.observation || '未知'} · 行情最新 ${stamp(data.price)}${data.signal ? ` · 日线信号最新 ${stamp(data.signal)}` : ''}</p>
    ${data.reasons.length ? `<p>${data.reasons.map(escapeHtml).join('；')}。可尝试「手动更新」，日期是否推进取决于来源数据。</p>` : ''}
    ${pack?.listNote ? `<p>${escapeHtml(pack.listNote)}</p>` : ''}
    <small>文件生成时间：${escapeHtml(generated)}；生成时间不代表行情更新。只读研究，不下单。</small></div>`;
}

export function observationHtml(observation) {
  if (!observation) return '';
  const row = observation.row || {};
  return `<section class="observation-context"><h3>观察生成时</h3><p>观察日 ${escapeHtml(validDate(observation.date) || '未知')} · 行情日 ${escapeHtml(validDate(row.priceDate) || '未知')} · 日线信号 ${escapeHtml(validDate(row.signalDate) || '未知')}</p><p>${escapeHtml(row.stageLabel || '暂无形态')} · ${escapeHtml(row.score ?? '—')} 分 · 版本 ${escapeHtml(versionLabel(row.version))}</p><p>以下单独读取最新可用数据，可能与观察快照不同；不会改写原观察记录。</p></section>`;
}
