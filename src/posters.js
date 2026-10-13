import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_POSTERS, todayStamp } from './paths.js';
import { accountById, loadAccounts, loadHoldings } from './holdings.js';
import { loadHistoricals, loadManyHistoricals } from './historicals.js';
import { loadQuotes } from './quotes.js';
import { buildPosterModel } from './levels.js';
import { closedBars } from './market-time.js';

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function signedChange(change, changePct) {
  if (changePct == null && change == null) return '';
  const pctText = changePct == null ? '' : `${changePct > 0 ? '+' : ''}${Number(changePct).toFixed(2)}%`;
  const chgText = change == null ? '' : `${change > 0 ? '+' : ''}${Number(change).toFixed(2)}`;
  const cls = changePct > 0 || change > 0 ? 'pos' : (changePct < 0 || change < 0 ? 'neg' : '');
  return `<span class="poster-chg ${cls}">${[chgText, pctText ? `(${pctText})` : ''].filter(Boolean).join(' ')}</span>`;
}

function nudgeYs(items, minGap, lo, hi) {
  const rows = items.map((row) => ({ ...row }));
  rows.sort((a, b) => a.y - b.y);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].y - rows[i - 1].y < minGap) rows[i].y = rows[i - 1].y + minGap;
  }
  const overflow = rows.length ? rows[rows.length - 1].y - hi : 0;
  if (overflow > 0) {
    for (const row of rows) row.y -= overflow;
  }
  if (rows[0]?.y < lo) {
    const shift = lo - rows[0].y;
    for (const row of rows) row.y += shift;
  }
  return rows;
}

export function renderChartSvg(model) {
  const bars = model.bars || [];
  if (bars.length < 2) return '<p class="poster-empty">日线不足，无法画图。</p>';
  const w = 1120;
  const chartH = 328;
  const volH = 64;
  const gap = 12;
  const pad = { l: 158, r: 18, t: 10, b: 6 };
  const innerW = w - pad.l - pad.r;
  const h = pad.t + chartH + gap + volH + pad.b;
  const lv = model.levels;
  const prices = [
    ...bars.flatMap((b) => [b.high, b.low]),
    lv.r2, lv.r1, lv.last, lv.s1, lv.s2, lv.sl, lv.ema50, lv.ema200,
    ...(model.ema20 || [])
  ].filter((n) => n != null);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i) => pad.l + (i / (bars.length - 1)) * innerW;
  const y = (p) => pad.t + (1 - (p - min) / span) * chartH;
  const cw = Math.max(2, innerW / bars.length * 0.62);
  const candles = bars.map((bar, i) => {
    const up = bar.close >= bar.open;
    const color = up ? '#1f7a4d' : '#a33b32';
    const bodyTop = y(Math.max(bar.open, bar.close));
    const bodyBot = y(Math.min(bar.open, bar.close));
    const bh = Math.max(1.2, bodyBot - bodyTop);
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(bar.high)}" y2="${y(bar.low)}" stroke="${color}" stroke-width="1"/>`
      + `<rect x="${x(i) - cw / 2}" y="${bodyTop}" width="${cw}" height="${bh}" fill="${color}"/>`;
  }).join('');
  const line = (arr, color, width = 1.35) => {
    if (!arr?.length) return '';
    const d = arr.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" opacity="0.9"/>`;
  };
  const guides = [
    { price: lv.r2, color: '#6b3fa0', title: '第二目标', sub: 'R2', kind: 'res' },
    { price: lv.r1, color: '#6b3fa0', title: '第一目标', sub: 'R1', kind: 'res' },
    { price: lv.last, color: '#c9a227', title: '现价', sub: '', kind: 'now' },
    { price: lv.s1, color: '#1f7a4d', title: '第一支撑', sub: 'S1', kind: 'sup' },
    { price: lv.s2, color: '#1f7a4d', title: '第二支撑', sub: 'S2', kind: 'sup' },
    { price: lv.sl, color: '#a33b32', title: '失效', sub: 'SL', kind: 'sl' }
  ].map((row) => ({ ...row, y: y(row.price) }));
  const placed = nudgeYs(guides, 22, pad.t + 10, pad.t + chartH - 8);
  const guideSvg = placed.map((row) => {
    const dash = row.kind === 'now' ? '6 5' : '0';
    const width = row.kind === 'now' ? 1.6 : 1.15;
    return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${row.y}" y2="${row.y}" stroke="${row.color}" stroke-dasharray="${dash}" stroke-width="${width}" opacity="0.88"/>`
      + `<circle cx="${pad.l - 10}" cy="${row.y}" r="5.5" fill="${row.color}"/>`
      + `<text x="10" y="${row.y - 4}" fill="${row.color}" font-size="11" font-family="IBM Plex Sans, sans-serif">${esc(row.title)}${row.sub ? ` ${row.sub}` : ''}</text>`
      + `<text x="10" y="${row.y + 11}" fill="${row.color}" font-size="12" font-family="IBM Plex Mono, monospace">${money(row.price)}</text>`;
  }).join('');
  const volTop = pad.t + chartH + gap;
  const volMax = Math.max(...bars.map((b) => b.volume || 0), 1);
  const volumes = bars.map((bar, i) => {
    const vh = Math.max(1, ((bar.volume || 0) / volMax) * volH);
    const up = bar.close >= bar.open;
    return `<rect x="${x(i) - cw / 2}" y="${volTop + volH - vh}" width="${cw}" height="${vh}" fill="${up ? '#1f7a4d' : '#a33b32'}" opacity="0.42"/>`;
  }).join('');
  return `<svg class="poster-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(model.symbol)} 日线">`
    + `<rect width="${w}" height="${h}" fill="#f7f3ea"/>`
    + `<text x="${pad.l}" y="${volTop - 3}" fill="#66705f" font-size="10" font-family="IBM Plex Mono, monospace">成交量</text>`
    + candles
    + line(model.ema20, '#7a8f6a', 1.1)
    + line(model.ema50, '#3d6aa0', 1.35)
    + line(model.ema200, '#b0893e', 1.45)
    + guideSvg
    + volumes
    + `</svg>`;
}

export function renderPosterHtml(model, { standalone = false } = {}) {
  if (!model?.ok) {
    return `<article class="poster"><h2>${esc(model?.symbol || '')}</h2><p>${esc(model?.error || '无法生成')}</p></article>`;
  }
  const lv = model.levels;
  const brief = model.brief || { emas: [], resistance: { title: '', lead: '', items: [] }, support: { title: '', lead: '', items: [] }, sizing: { title: '', lead: '', lines: [] }, table: [] };
  const idea = model.idea;
  const chg = signedChange(model.change, model.changePct);
  const emaStrip = (brief.emas || []).map((row) => (
    `<li>EMA${row.period} <b>${money(row.value)}</b></li>`
  )).join('');
  const cardItems = (card) => (card.items || []).map((item) => (
    `<p><strong>${esc(item.label)} ${money(item.price)}</strong> — ${esc(item.text)}</p>`
  )).join('');
  const sizeLines = (brief.sizing.lines || []).map((line) => `<li>${esc(line)}</li>`).join('');
  const rows = (brief.table || []).map((row) => (
    `<tr class="${row.kind}"><th>${esc(row.label)}</th><td>${money(row.price)}</td><td>${esc(row.meaning)}</td><td>${esc(row.action)}</td></tr>`
  )).join('');
  const orders = (model.plan.orders || []).map((row) => `<li>${esc(row)}</li>`).join('');
  const ideaBox = idea
    ? `<div class="poster-card idea"><h3>今日买卖草稿 · ${esc(idea.side)}</h3>
        <p><strong>${esc(idea.side)} ${idea.qty} @ ${money(idea.price)}</strong></p>
        <p>${esc(idea.reason || '')}</p>
        <p class="poster-note">草稿，不是已经挂上的单。</p></div>`
    : '';
  const inner = `<article class="poster" data-symbol="${esc(model.symbol)}">
    <header class="poster-head">
      <p class="poster-kicker">如何阅读价位图 · 例：${esc(model.symbol)} 日线 · ${esc(model.accountLabel)}</p>
      <div class="poster-quote">
        <h1>${esc(model.symbol)} <span>${esc(model.name)}</span></h1>
        <p class="poster-px">${money(model.last)} ${chg} <span class="asof">截至 ${esc(model.asOf || '—')}</span></p>
      </div>
      <p class="poster-meta">${esc(model.role || '持仓')} · ${model.qty} 股 · 成本 ${money(model.avgCost)} · 浮盈亏 ${money(model.pnl)}${model.pnlPct != null ? `（${model.pnlPct > 0 ? '+' : ''}${model.pnlPct.toFixed(1)}%）` : ''}</p>
    </header>
    <section class="poster-legend">
      <span class="lg res"><i></i>紫色 = 现价上方，阻力 / 短线目标</span>
      <span class="lg now"><i></i>黄色虚线 = 现价</span>
      <span class="lg sup"><i></i>绿色 = 现价下方，支撑 / 潜在入场</span>
      <span class="lg sl"><i></i>红色 = 失效 / 止损参考</span>
    </section>
    <ul class="poster-ema-strip">${emaStrip}<li>趋势 ${lv.trend}/10</li></ul>
    ${renderChartSvg(model)}
    <section class="poster-grid">
      <div class="poster-card res"><h3>${esc(brief.resistance.title)}</h3><p>${esc(brief.resistance.lead)}</p>${cardItems(brief.resistance)}</div>
      <div class="poster-card sup"><h3>${esc(brief.support.title)}</h3><p>${esc(brief.support.lead)}</p>${cardItems(brief.support)}</div>
      <div class="poster-card size"><h3>${esc(brief.sizing.title)}</h3><p>${esc(brief.sizing.lead)}</p><ul>${sizeLines}</ul></div>
      <div class="poster-card plan">
        <h3>今日建议 · ${esc(model.plan.action)}</h3>
        <p><strong>${esc(model.plan.title)}</strong></p>
        <p>${esc(model.plan.detail)}</p>
        <ul>${orders || '<li>无必须执行单</li>'}</ul>
      </div>
      ${ideaBox}
    </section>
    <p class="poster-warn">价位是技术参考，不是保证。按你的持仓、成本和账户职责用，不是支撑 ±5%–10% 的买卖带。未接入财报日历，不编造事件天数。趋势分只看价与均线。</p>
    <h3 class="poster-table-title">${esc(model.symbol)} 警报水平汇总</h3>
    <table class="poster-table">
      <thead><tr><th>类型</th><th>价格</th><th>含义</th><th>操作参考</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </article>`;
  if (!standalone) return inner;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(model.symbol)} 价位图</title>
    <link rel="stylesheet" href="/styles.css"/><link rel="stylesheet" href="/poster.css"/>
    </head><body class="poster-print">${inner}</body></html>`;
}

export function renderOverviewHtml(pack) {
  const rows = (pack.cards || []).map((card) => {
    if (!card.ok) {
      return `<tr><th>${esc(card.symbol)}</th><td colspan="8">${esc(card.error)}</td></tr>`;
    }
    return `<tr>
      <th>${esc(card.symbol)}</th>
      <td>${esc(card.plan.action)}</td>
      <td>${money(card.last)}</td>
      <td>${money(card.levels.r1)}</td>
      <td>${money(card.levels.r2)}</td>
      <td>${money(card.levels.s1)}</td>
      <td>${money(card.levels.s2)}</td>
      <td>${money(card.levels.sl)}</td>
      <td>${card.levels.trend}/10</td>
    </tr>`;
  }).join('');
  return `<article class="poster poster-overview">
    <header class="poster-head">
      <p class="poster-kicker">${esc(pack.accountLabel)} · 价位总览 · ${esc(pack.date)}</p>
      <h1>账户价位图</h1>
      <p class="poster-meta">${pack.cards.length} 只 · 规则算法，不是统一百分比。不改真实持仓，不是下单指令。</p>
    </header>
    <table class="poster-table">
      <thead><tr><th>代码</th><th>建议</th><th>现价</th><th>R1</th><th>R2</th><th>S1</th><th>S2</th><th>SL</th><th>趋势</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </article>`;
}

async function posterForPosition(account, position, hist, quote) {
  if (!hist?.ok) {
    return {
      ok: false,
      symbol: position.symbol,
      name: position.name || position.symbol,
      error: hist?.error || '无日线'
    };
  }
  return buildPosterModel({ account, position, bars: closedBars(hist.bars), quote });
}

export function renderResearchPosterHtml(model, quoteAt) {
  if (!model?.ok) return `<p class="poster-empty">${esc(model?.error || '暂无价位图')}</p>`;
  const sourceTime = quoteAt && Number.isFinite(new Date(quoteAt).getTime()) && new Date(quoteAt).getTime() > 0 ? new Date(quoteAt).toISOString() : '未知';
  return `<article class="poster"><header class="poster-head"><p class="poster-kicker">${esc(model.symbol)} · 独立行情与日线参考</p><p class="poster-px">报价 ${money(model.last)}</p><p class="poster-note">行情时间 ${esc(sourceTime)} · 图表日线截至 ${esc(model.asOf || '未知')}。数据独立读取，可能与上方周期参考价不同。</p></header>
    <section class="poster-legend"><span>紫色：阻力</span><span>黄色：参考价</span><span>绿色：支撑</span><span>红色：图表失效位</span></section>
    ${renderChartSvg(model)}
    <p class="poster-note">R1 ${money(model.levels.r1)} · R2 ${money(model.levels.r2)} · S1 ${money(model.levels.s1)} · S2 ${money(model.levels.s2)} · 图表失效 ${money(model.levels.sl)}</p>
    <p class="poster-note">图表失效位与策略失效条件计算口径不同。仅展示技术参考，不生成账户操作或买卖草稿。</p></article>`;
}

export async function buildSymbolPoster({ symbol, accountId = 'main', deskId = 'grok', researchOnly = false } = {}) {
  const key = String(symbol || '').toUpperCase();
  if (!key) return { ok: false, error: 'missing-symbol' };
  const config = await loadAccounts(deskId);
  const account = accountById(config, accountId) || { id: accountId, label: '观察' };
  let holdings = { positions: [] };
  try {
    if (accountById(config, accountId)) holdings = await loadHoldings(account);
  } catch {
    holdings = { positions: [] };
  }
  const held = (holdings.positions || []).find((row) => String(row.symbol).toUpperCase() === key);
  const position = held || { symbol: key, name: key, qty: 0 };
  const [hist, quotes] = await Promise.all([
    loadHistoricals(key),
    loadQuotes([key])
  ]);
  const model = await posterForPosition(account, position, hist, quotes[key]);
  const card = { ...model, html: model.ok ? (researchOnly ? renderResearchPosterHtml(model, quotes[key]?.quoteAt) : renderPosterHtml(model)) : '' };
  return {
    ok: Boolean(model.ok),
    liveTrading: false,
    date: todayStamp(),
    deskId,
    accountId: account.id,
    accountLabel: account.label,
    symbol: key,
    held: Boolean(held),
    cards: [card],
    error: model.ok ? null : (model.error || '无日线')
  };
}

export async function buildAccountPosters({ accountId = 'main', deskId = 'grok', symbol } = {}) {
  if (symbol) return buildSymbolPoster({ symbol, accountId, deskId });
  const config = await loadAccounts(deskId);
  const account = accountById(config, accountId);
  if (!account) return { ok: false, error: 'unknown-account' };
  const holdings = await loadHoldings(account);
  const positions = (holdings.positions || []).filter((row) => row.symbol && Number(row.qty) > 0);
  const symbols = positions.map((row) => row.symbol);
  const [hists, quotes] = await Promise.all([
    loadManyHistoricals(symbols),
    loadQuotes(symbols)
  ]);
  const cards = [];
  for (const pos of positions) {
    const model = await posterForPosition(account, pos, hists[pos.symbol], quotes[pos.symbol]);
    cards.push({
      ...model,
      html: renderPosterHtml(model)
    });
  }
  const pack = {
    ok: true,
    liveTrading: false,
    date: todayStamp(),
    deskId,
    accountId,
    accountLabel: account.label,
    asOf: holdings.asOf,
    cards
  };
  pack.overviewHtml = renderOverviewHtml(pack);
  return pack;
}

export async function writePosters(pack) {
  const dir = join(OBSIDIAN_POSTERS, pack.date);
  await mkdir(dir, { recursive: true });
  const json = `${JSON.stringify({
    date: pack.date,
    accountId: pack.accountId,
    cards: pack.cards.map((card) => card.ok ? {
      symbol: card.symbol,
      action: card.plan.action,
      last: card.last,
      levels: card.levels,
      orders: card.plan.orders
    } : { symbol: card.symbol, error: card.error })
  }, null, 2)}\n`;
  await writeFile(join(dir, `${pack.accountId}.json`), json, 'utf8');
  await writeFile(join(dir, `${pack.accountId}-总览.html`), `${renderOverviewPage(pack)}\n`, 'utf8');
  for (const card of pack.cards) {
    if (!card.ok) continue;
    await writeFile(join(dir, `${pack.accountId}-${card.symbol}.html`), `${renderStandalonePage(card)}\n`, 'utf8');
  }
  return { dir, count: pack.cards.filter((c) => c.ok).length };
}

function posterCssHref() {
  return `<style>${POSTER_EMBED_CSS}</style>`;
}

const POSTER_EMBED_CSS = `
body.poster-print{margin:0;background:#f3eee3;color:#1c2118;font-family:"IBM Plex Sans","Segoe UI",sans-serif;}
.poster{max-width:1120px;margin:0 auto;padding:28px 32px 40px;background:#f7f3ea;}
.poster-kicker{margin:0 0 8px;color:#b0893e;font:11px/1 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;}
.poster h1{margin:0;font-family:Fraunces,serif;font-weight:500;}
.poster h1 span{font-size:.55em;color:#66705f;margin-left:.4em;}
.poster-quote{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:end;margin:4px 0 8px;}
.poster-px{margin:0;font:22px/1.2 "IBM Plex Mono",monospace;}
.poster-chg.pos{color:#1f7a4d}.poster-chg.neg{color:#a33b32}
.poster-px .asof{font-size:13px;color:#66705f;margin-left:8px;}
.poster-meta,.poster-note{color:#66705f;font-size:13px;}
.poster-legend{display:flex;flex-wrap:wrap;gap:10px 18px;margin:14px 0 8px;font-size:13px;}
.lg i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle;}
.lg.res{color:#6b3fa0}.lg.res i{background:#6b3fa0}
.lg.sup{color:#1f7a4d}.lg.sup i{background:#1f7a4d}
.lg.sl{color:#a33b32}.lg.sl i{background:#a33b32}
.lg.now{color:#c9a227}.lg.now i{background:#c9a227}
.poster-ema-strip{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 10px;padding:0;list-style:none;font:12px/1.4 "IBM Plex Mono",monospace;color:#66705f;}
.poster-ema-strip b{color:#1c2118;font-weight:500;}
.poster-chart{width:100%;height:auto;border:1px solid rgba(28,33,24,.12);background:#f7f3ea;}
.poster-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0;}
.poster-card{border:1px solid rgba(28,33,24,.12);padding:14px 16px;}
.poster-card.res{border-color:#6b3fa0;background:rgba(107,63,160,.04)}
.poster-card.sup{border-color:#1f7a4d;background:rgba(31,122,77,.04)}
.poster-card.size{border-color:#3d6aa0;background:rgba(61,106,160,.05)}
.poster-card.idea{border-color:#b0893e;background:rgba(176,137,62,.08)}
.poster-card h3{margin:0 0 8px;font-size:15px}
.poster-card p,.poster-card li{margin:0 0 6px;font-size:14px}
.poster-warn{margin:8px 0 16px;padding:10px 12px;border:1px solid #c9a227;background:rgba(201,162,39,.12);color:#5c4a1f;font-size:13px;}
.poster-table-title{margin:18px 0 6px;font-size:16px;}
.poster-table{width:100%;border-collapse:collapse;font-size:14px}
.poster-table th,.poster-table td{border-top:1px solid rgba(28,33,24,.12);padding:8px 10px;text-align:left}
.poster-table .res th{color:#6b3fa0}.poster-table .sup th{color:#1f7a4d}.poster-table .sl th{color:#a33b32}.poster-table .now th{color:#c9a227}
`;

function renderStandalonePage(model) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(model.symbol)} 价位图</title>${posterCssHref()}</head><body class="poster-print">${renderPosterHtml(model)}</body></html>`;
}

function renderOverviewPage(pack) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(pack.accountLabel)} 价位总览</title>${posterCssHref()}</head><body class="poster-print">${renderOverviewHtml(pack)}</body></html>`;
}

export function posterPage(model) {
  return renderStandalonePage(model);
}
