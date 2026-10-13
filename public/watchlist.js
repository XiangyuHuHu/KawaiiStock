import { stageStripHtml, universeStageHtml, versionRateText } from './strategy-rate.js';
import { escapeHtml, freshnessHtml, matchesWatchFilter, uniqueWatchRows, WATCH_FILTERS, watchFreshness, validDate } from './watch-view.js';

function fmt(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(digits);
}

function signed(n, suffix = '') {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}${suffix}`;
}

function px(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function pickResult(pack, row) {
  const days = pack?.score?.days || [];
  const day = days.find((item) => item.callDate === pack.date);
  return (day?.picks || []).find((item) => item.symbol === row.symbol && item.side === row.side && Math.abs(item.from - row.last) < 0.00001);
}

function hitBadge(result) {
  if (!result) return '';
  if (result.status === 'pending' && result.retPct == null) {
    return '<span class="watch-hit is-pending">待次日收盘</span>';
  }
  const cls = result.status === 'pending' ? 'is-pending' : (result.hit ? 'is-hit' : 'is-miss');
  const label = result.status === 'pending'
    ? '进行中'
    : (result.hit ? (result.useful ? '次日对 · 有意义' : '次日对') : '次日错');
  return `<span class="watch-hit ${cls}">${label} ${signed(result.retPct, '%')}</span>`;
}

function featuredCard(row, pack) {
  const cls = row.side === 'up' ? 'is-go' : 'is-avoid';
  const band = row.band
    ? `${px(row.band.low)} ~ ${px(row.band.high)} · ±${px(row.band.dollars)}（${signed(row.band.pct, '%')}）`
    : '波动带 DATA UNAVAILABLE';
  const stretch = row.stretch
    ? `${px(row.stretch.low)} ~ ${px(row.stretch.high)} · ±${px(row.stretch.dollars)}`
    : '—';
  return `<article class="watch-feature ${cls}">
    <header>
      <strong><button type="button" class="watch-symbol" data-open-symbol="${escapeHtml(row.symbol)}">${escapeHtml(row.symbol)} <span>查看详情 →</span></button></strong>
      <span>${row.stageLabel || '—'} · ${row.score ?? '—'}分</span>
      ${hitBadge(pickResult(pack, row))}
    </header>
    <p class="watch-tags">${(row.tags || []).map(escapeHtml).join(' · ')}</p>
    <p class="strategy-line">${row.allowNewLong ? '观察时已确认' : '观察时未确认 · 不开仓'} · ${escapeHtml(versionRateText(row, pack.score))}</p>
    <p>观察日 ${validDate(pack.date) || '未知'} · 行情 ${validDate(row.priceDate) || '未知'} · 日线 ${validDate(row.signalDate) || '未知'}</p>
    <dl>
      <div><dt>观察参考价</dt><dd>${px(row.last)}</dd></div>
      <div><dt>该行情日涨跌</dt><dd>${signed(row.changePct, '%')}</dd></div>
      <div><dt>上行参考 R1</dt><dd>${px(row.upside?.r1)}</dd></div>
      <div><dt>失效参考</dt><dd>${px(row.downside?.stop ?? row.stop)}</dd></div>
    </dl>
    <details class="watch-card-details"><summary>波动与价位依据</summary><dl>
      <div><dt>ATR</dt><dd>${px(row.atr)} · ${row.atrPct == null ? '—' : `${fmt(row.atrPct)}%`}</dd></div>
      <div><dt>20日年化波动</dt><dd>${row.vol20 == null ? '—' : `${fmt(row.vol20)}%`}</dd></div>
      <div class="wide"><dt>观察时波动范围</dt><dd>${band}</dd></div>
      <div class="wide"><dt>拉伸波动</dt><dd>${stretch}</dd></div>
      <div class="wide"><dt>上行价位</dt><dd>R1 ${px(row.upside?.r1)} · R2 ${px(row.upside?.r2)}</dd></div>
      <div class="wide"><dt>下行价位</dt><dd>S1 ${px(row.downside?.s1)} · 距离 ${row.downside?.toS1Pct == null ? '—' : `${fmt(Math.abs(row.downside.toS1Pct))}%`} · 失效 ${px(row.downside?.stop ?? row.stop)}</dd></div>
    </dl>
    <p>波动范围由 ATR / 支撑阻力估算，不是预测成交价。</p></details>
  </article>`;
}

function cnFeaturedCard(row) {
  const cls = row.side === 'up' ? 'is-go' : 'is-avoid';
  return `<article class="watch-feature ${cls}">
    <header>
      <strong><button type="button" class="watch-symbol" data-open-symbol="${escapeHtml(row.symbol)}" data-market="cn">${escapeHtml(row.symbol)} <span>查看详情 →</span></button></strong>
      <span>${row.company || ''} · ${row.stageLabel || ''}</span>
    </header>
    <p>${(row.tags || []).map(escapeHtml).join(' · ')} · 行情日 ${validDate(row.priceDate) || '未知'}</p>
    <dl>
      <div><dt>现价</dt><dd>${row.last == null ? '—' : `¥${fmt(row.last, 2)}`}</dd></div>
      <div><dt>当日</dt><dd>${signed(row.changePct, '%')}</dd></div>
      <div><dt>换手</dt><dd>${row.turnover == null ? '—' : `${fmt(row.turnover)}%`}</dd></div>
      <div><dt>PE</dt><dd>${row.pe == null || row.pe <= 0 ? '—' : fmt(row.pe)}</dd></div>
    </dl>
  </article>`;
}

function cnMiniCard(row) {
  return `<article class="watch-card ${row.side === 'up' ? 'is-go' : 'is-avoid'}">
    <header>
      <strong><button type="button" class="watch-symbol" data-open-symbol="${escapeHtml(row.symbol)}" data-market="cn">${escapeHtml(row.symbol)} <span>查看详情 →</span></button></strong>
      <span>${row.company || row.stageLabel || ''}</span>
    </header>
    <p>${(row.tags || []).map(escapeHtml).join(' · ')} · 行情日 ${validDate(row.priceDate) || '未知'}</p>
    <dl>
      <div><dt>现价</dt><dd>${row.last == null ? '—' : fmt(row.last, 2)}</dd></div>
      <div><dt>当日</dt><dd>${signed(row.changePct, '%')}</dd></div>
      <div><dt>换手</dt><dd>${row.turnover == null ? '—' : `${fmt(row.turnover)}%`}</dd></div>
      <div><dt>PE</dt><dd>${row.pe == null || row.pe <= 0 ? '—' : fmt(row.pe)}</dd></div>
    </dl>
  </article>`;
}

function cnSectionHtml(title, kicker, rows, empty) {
  return `<section class="watch-section">
    <p class="watch-kicker">${kicker}</p>
    <h3>${title}</h3>
    <div class="watch-cards">${rows?.length ? rows.map(cnMiniCard).join('') : `<p class="watch-empty">${empty}</p>`}</div>
  </section>`;
}

function cnWatchHtml(cn) {
  if (!cn || cn.empty || cn.ok === false) {
    return `<p class="watch-empty">${cn?.note || cn?.error || '还没有 A 股观察。点「扫描并写入」会按 list 公开行情生成。'}</p>`;
  }
  const boards = cn.boards || {};
  const rows = uniqueWatchRows(cn);
  cn = { ...cn, featured: { up: rows.filter(row => row.featured && row.side === 'up'), down: rows.filter(row => row.featured && row.side === 'down') } };
  return [
    `<section class="watch-featured">
      <div>
        <p class="watch-kicker">CN Up</p>
        <h3>该观察日偏多</h3>
        <div class="watch-features">${cn.featured?.up?.length ? cn.featured.up.map(cnFeaturedCard).join('') : '<p class="watch-empty">list 里没有收涨的名字。</p>'}</div>
      </div>
      <div>
        <p class="watch-kicker">CN Down</p>
        <h3>该观察日偏空</h3>
        <div class="watch-features">${cn.featured?.down?.length ? cn.featured.down.map(cnFeaturedCard).join('') : '<p class="watch-empty">list 里没有收跌的名字。</p>'}</div>
      </div>
    </section>`,
    cnSectionHtml('更多观察 · 每只股票仅展示一次', 'CN Watch', rows.filter(row => !row.featured), '没有其他观察对象。')
  ].join('');
}

const watchState = {
  market: localStorage.getItem('kawaii-watch-market') === 'cn' ? 'cn' : 'us',
  us: null,
  cn: null
};
let watchFilter = 'all';

function setWatchMarket(market) {
  watchState.market = market === 'cn' ? 'cn' : 'us';
  localStorage.setItem('kawaii-watch-market', watchState.market);
  document.querySelectorAll('#watchMarket [data-watch-market]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.watchMarket === watchState.market);
  });
}

function featuredHtml(pack) {
  const up = pack.featured?.up || [];
  const down = pack.featured?.down || [];
  return `<section class="watch-featured">
    <div>
      <p class="watch-kicker">Bullish Watch</p>
    <h3>偏多观察</h3>
      <div class="watch-features">${up.length ? up.map((row) => featuredCard(row, pack)).join('') : '<p class="watch-empty">今日没有足够证据的上涨候选。</p>'}</div>
    </div>
    <div>
      <p class="watch-kicker">Bearish Watch</p>
      <h3>偏空观察</h3>
      <div class="watch-features">${down.length ? down.map((row) => featuredCard(row, pack)).join('') : '<p class="watch-empty">今日没有足够证据的下跌候选。</p>'}</div>
    </div>
  </section>`;
}

function hitsText(side) {
  if (!side?.n) return '—';
  return `${side.hits}/${side.n}`;
}

function sampleLabel(stats) {
  if (!stats?.n) return '待结算';
  if ((stats.days || 0) < 20 || stats.n < 100) return '试运行';
  if ((stats.days || 0) < 60 || stats.n < 300) return '样本形成中';
  return '样本较稳定';
}

function confidenceText(stats) {
  const confidence = stats?.confidence;
  if (confidence?.low == null || confidence?.high == null) return '区间待计算';
  return `${confidence.level || 95}%区间 ${confidence.low}%–${confidence.high}%`;
}

function scoreHtml(score) {
  if (!score?.ok) {
    return `<section class="watch-score"><p class="watch-empty">${score?.error || '精选候选次日方向命中率还没有记录，点击手动更新采集并结算。'}</p></section>${universeStageHtml(score)}`;
  }
  const all = score.locked?.all || {};
  const up = score.locked?.up || {};
  const down = score.locked?.down || {};
  const pendingN = score.pending?.length || 0;
  const baseline = all.baselines || {};
  const usefulN = all.usefulN ?? all.n ?? 0;
  return `${universeStageHtml(score)}
  <details class="watch-featured-stats">
  <summary>查看精选候选统计（仅每日看涨 / 看跌各 3 只）</summary>
  <p class="watch-scope-note">以下命中率只针对精选候选，与上方全观察池的样本数量分别统计。</p><section class="watch-score">
    <div><span>次日方向命中率</span><strong>${all.rate == null ? '待结算' : `${all.rate}%`}</strong><small>${all.n ? `${all.hits}/${all.n} 对 · ${all.days || 0} 个交易日` : '还没有次日收盘'}</small></div>
    <div><span>上涨候选</span><strong>${hitsText(up)}</strong><small>${up.rate == null ? '待结算' : `${up.rate}% · 方向收益 ${signed(up.avgDirectionalRet ?? up.avgRet, '%')}`}</small></div>
    <div><span>下跌候选</span><strong>${hitsText(down)}</strong><small>${down.rate == null ? '待结算' : `${down.rate}% · 方向收益 ${signed(down.avgDirectionalRet, '%')}`}</small></div>
    <div><span>有意义</span><strong>${usefulN ? `${all.useful}/${usefulN}` : '—'}</strong><small>方向对且至少 0.5 ATR${all.usefulUnknown ? ` · ${all.usefulUnknown} 只缺 ATR` : ''}${pendingN ? ` · ${pendingN} 只待收盘` : ''}</small></div>
  </section>
  <section class="watch-edge">
    <div><span>样本可信度</span><strong>${sampleLabel(all)}</strong><small>${confidenceText(all)}</small></div>
    <div><span>平均方向收益</span><strong>${signed(all.avgDirectionalRet, '%')}</strong><small>看跌已反向计分</small></div>
    <div><span>命中 / 错误均值</span><strong>${signed(all.avgWin, '%')} / ${signed(all.avgLoss, '%')}</strong><small>盈亏比 ${all.payoffRatio ?? '—'}</small></div>
    <div><span>最佳简单基线</span><strong>${baseline.bestSimpleRate == null ? '—' : `${baseline.bestSimpleRate}%`}</strong><small>${baseline.bestSimple || '—'} · 策略 ${baseline.edgePctPoints == null ? '—' : `${baseline.edgePctPoints > 0 ? '+' : ''}${baseline.edgePctPoints}pp`}</small></div>
    <div><span>方向期望值</span><strong>${signed(all.expectancy, '%')}/次</strong><small>未计成本 · 不是实盘收益</small></div>
  </section>
  ${stageStripHtml(score)}</details>`;
}

function recentRows(score) {
  const rows = (score?.recent || []).slice(0, 12);
  if (!rows.length) return '<p class="watch-empty">还没有次日结果。</p>';
  return `<ul class="watch-score-log">${rows.map((row) => {
    const mark = row.status === 'pending' ? '待' : (row.hit ? '对' : '错');
    const cls = row.status === 'pending' ? 'is-pending' : (row.hit ? 'is-hit' : 'is-miss');
    return `<li class="${cls}"><strong>${row.symbol}</strong> ${row.stageLabel || ''} ${row.side === 'down' ? '跌' : '涨'} ${signed(row.retPct, '%')} <span>${mark}</span></li>`;
  }).join('')}</ul>`;
}

function cardHtml(row, pack) {
  const cls = row.allowNewLong ? 'is-go' : (row.feeds || []).includes('avoid') ? 'is-avoid' : '';
  return `<article class="watch-card ${cls}">
    <header>
      <strong><button type="button" class="watch-symbol" data-open-symbol="${escapeHtml(row.symbol)}">${escapeHtml(row.symbol)} <span>查看详情 →</span></button></strong>
      <span>${row.stageLabel || '—'}</span>
    </header>
    <p>${(row.tags || []).map(escapeHtml).join(' · ')} · ${row.allowNewLong ? '已确认' : '待确认 / 观察'}</p>
    <p>行情 ${validDate(row.priceDate) || '未知'} · 日线 ${validDate(row.signalDate) || '未知'}</p>
    <dl>
      <div><dt>当前版本精选统计</dt><dd>${escapeHtml(versionRateText(row, pack?.score))}</dd></div>
      <div><dt>分数</dt><dd>${row.score ?? '—'}</dd></div>
      <div><dt>现价</dt><dd>${row.last == null ? '—' : fmt(row.last, 2)}</dd></div>
      <div><dt>当日</dt><dd>${signed(row.changePct, '%')}</dd></div>
      <div><dt>RS20</dt><dd>${signed(row.rs20)}</dd></div>
      <div><dt>量能</dt><dd>${row.volumeRatio == null ? '—' : `${fmt(row.volumeRatio)}x`}</dd></div>
      <div><dt>失效</dt><dd>${row.stop == null ? '—' : fmt(row.stop, 2)}</dd></div>
    </dl>
    <details class="watch-card-details"><summary>查看形态依据与限制</summary>
      <p>原策略确认：${row.allowNewLong && row.confirmation?.confirmed ? '已确认' : '尚未确认新开仓'}。评分沿用每日观察的 Cycle 分，不另建一套分数。</p>
      ${Array.isArray(row.confirmation?.reasons) && row.confirmation.reasons.length ? `<p>确认检查：${row.confirmation.reasons.map(escapeHtml).join('；')}</p>` : ''}
      <p>${escapeHtml(row.note || '暂无更多原策略说明。')}</p>
    </details>
  </article>`;
}

function sectionHtml(title, kicker, rows, empty, pack) {
  return `<section class="watch-section">
    <p class="watch-kicker">${kicker}</p>
    <h3>${title}</h3>
    <div class="watch-cards">${rows?.length ? rows.map((row) => cardHtml(row, pack)).join('') : `<p class="watch-empty">${empty}</p>`}</div>
  </section>`;
}

function bindWatchCards(root, pack = watchState[watchState.market]) {
  root?.querySelectorAll('[data-open-symbol]').forEach((el) => {
    el.addEventListener('click', async () => {
      const { openSymbolDetail } = await import('./screener.js');
      const symbol = el.dataset.openSymbol;
      const cn = el.dataset.market === 'cn' || /^\d{6}$/.test(symbol);
      const row = uniqueWatchRows(pack).find(row => row.symbol === symbol);
      openSymbolDetail(symbol, { symbol, company: row?.company, market: cn ? 'cn' : 'us', currency: cn ? 'CNY' : 'USD', observation: { date: pack?.date, row } });
    });
  });
}

function validationHtml(report) {
  if (!report || report.empty || !report.results) return '<p class="watch-empty">策略净收益验证尚未生成。方向命中率不等于交易盈利。</p>';
  const rows = report.results.filter((row) => row.window === 'holdout');
  return `<section class="watch-validation"><p class="watch-kicker">Strategy Validation · Experimental</p>
    <h3>策略净收益验证 · 仍未证明盈利</h3>
    <p>时间留出 ${rows[0]?.start || '—'} 至 ${rows[0]?.end || '—'}；独立于上方的次日方向命中率。小样本不能判断优势。</p>
    <div class="watch-validation-table"><table><thead><tr><th>版本</th><th>成交</th><th>胜率</th><th>净收益</th><th>最大回撤</th><th>平均仓位</th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td>${row.version === 'v2' ? 'V2 收盘确认' : 'V1 旧规则'}</td><td>${row.trades}</td><td>${fmt(row.winRate)}%</td><td>${signed(row.netReturnPct, '%')}</td><td>${fmt(row.maxDrawdownPct, 2)}%</td><td>${fmt(row.averageExposurePct)}%</td></tr>`).join('')}
    </tbody></table></div>
    <p>每边 5bp 滑点；V2 每边 20bp 压力测试 ${signed(report.stress?.netReturnPct, '%')}。新版风险预算：每笔 0.5%、单股市值 10%、组合止损风险 2.5%。止损不保证成交价。</p>
    <p>回撤变小可能只因持仓更少。当前股票池、约一年日线，存在选择偏差；未计完整交易成本，未独立核验复权。不是实盘业绩，也不是未来收益承诺。</p>
  </section>`;
}

function renderUsWatch(pack) {
  const status = document.getElementById('watchStatus');
  const grid = document.getElementById('watchGrid');
  const side = document.getElementById('watchSide');
  const meta = document.getElementById('watchMeta');
  const title = document.getElementById('watchTitle');
  const kicker = document.getElementById('watchKicker');
  const sub = document.getElementById('watchSub');
  if (kicker) kicker.textContent = 'Daily Watchlist · Cycle of Price Action';
  if (sub) sub.textContent = '先看确认状态与观察日期，再查看样本复盘。分数不是概率；只读研究，不下单。';
  if (!pack || pack.empty || pack.ok === false) {
    title.textContent = '美股每日观察';
    meta.innerHTML = '';
    grid.innerHTML = validationHtml(pack?.validation);
    side.innerHTML = `<ul>
      <li>足迹不是预测。</li>
      <li>每交易日重新确认。</li>
      <li>证据齐了再按计划做。</li>
      <li>0C 没有 A 级就空仓。</li>
    </ul>`;
    status.textContent = pack?.error
      ? `美股观察板失败：${pack.error}`
      : (pack?.note || '今日还没有美股观察。点「扫描并写入」。');
    return;
  }
  const boards = pack.boards || {};
  const locked = pack.score?.locked?.all;
  title.textContent = `${pack.date} 美股观察`;
  meta.innerHTML = [
    ['大盘', pack.regimeLabel || pack.regime || '—'],
    ['扫描', pack.scanned ?? '—'],
    ['观察时确认', pack.counts?.confirmed ?? '未知'],
    ['观察卡片', `${uniqueWatchRows(pack).length} 只（已去重）`]
  ].map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  const rows = uniqueWatchRows(pack);
  const decorated = { ...pack, featured: { up: rows.filter(row => row.featured && row.side === 'up'), down: rows.filter(row => row.featured && row.side === 'down') } };
  const filtered = rows.filter((row) => matchesWatchFilter(row, watchFilter));
  const filterBar = `<div class="list-pills watch-filter-pills" aria-label="观察候选分类">${WATCH_FILTERS.map(([id, label]) => `<button type="button" class="pill ${watchFilter === id ? 'is-active' : ''}" data-watch-filter="${id}">${escapeHtml(label)} · ${rows.filter((row) => matchesWatchFilter(row, id)).length}</button>`).join('')}</div>
    <p class="watch-scope-note">按已保存的美股候选形态筛选；沿用上方 Cycle 分数和原策略确认状态。只读研究，不代表全市场实时扫描。</p>`;
  const all = pack.score?.universe?.all;
  grid.innerHTML = `<p class="watch-pool-summary">全观察池：${all ? `已记录 ${all.observed} · 已结算 ${all.n} · 待结算 ${all.pending} · 排除 ${all.excluded}` : '尚未采集完整样本'}。<a href="#watchSamples">查看形态与逐条原因 ↓</a></p>
    <nav class="watch-local-nav" aria-label="每日观察内容"><a href="#watchCandidates">观察候选</a><a href="#watchSamples">样本复盘</a><a href="#watchValidation">策略验证</a></nav>
    <section id="watchCandidates">${filterBar}${watchFilter === 'all'
      ? `${featuredHtml(decorated)}${sectionHtml('更多观察 · 每只股票仅展示一次', 'Watch', rows.filter(row => !row.featured), '没有其他观察对象。', pack)}`
      : sectionHtml(`${WATCH_FILTERS.find(([id]) => id === watchFilter)?.[1] || '观察筛选'} · ${filtered.length} 只`, 'Filtered Watch', filtered, '当前保存快照没有符合此形态的候选。', pack)}</section>
    <section id="watchSamples">${scoreHtml(pack.score)}</section>
    <details id="watchValidation"><summary>策略验证 · 查看收益、回撤与限制</summary>${validationHtml(pack.validation)}</details>`;
  side.innerHTML = `<p class="watch-kicker">Directional Hit Rate</p>
    <h3>次日复盘</h3>
    <ul>
      <li>精选命中率只结算每日偏多 / 偏空各 3 只。</li>
      <li>下一交易日收盘 vs 观察日现价。</li>
      <li>涨候选收涨算对，跌候选收跌算对。</li>
      <li>平盘不算对。有意义要走出 0.5 ATR。</li>
      <li>策略分是排序分，不是上涨概率。</li>
      <li>少于 20 个交易日或 100 个样本统一标为试运行。</li>
      <li>阶段命中率是全历史观察，不能当作新版交易胜率。</li>
      <li>同日股票相关，置信区间可能偏窄。</li>
      <li>日线信号在收盘后更新，报价不是实时交易所数据。</li>
    </ul>
    ${recentRows(pack.score)}
    <p class="watch-foot">${pack.note || ''}</p>`;
  status.textContent = pack.listError
    ? `清单缺失：${pack.listError}`
    : `${pack.stale ? `今日 ${pack.requestedDate || '尚未扫描'}，先显示 ${pack.date}。` : ''} ${pack.date} ${pack.strategy?.name || 'Cycle'} · 大盘 ${pack.regimeLabel || pack.regime} · 扫描 ${pack.scanned}。`.trim();
  bindWatchCards(grid);
}

function renderCnWatch(cn) {
  const status = document.getElementById('watchStatus');
  const grid = document.getElementById('watchGrid');
  const side = document.getElementById('watchSide');
  const meta = document.getElementById('watchMeta');
  const title = document.getElementById('watchTitle');
  const kicker = document.getElementById('watchKicker');
  const sub = document.getElementById('watchSub');
  if (kicker) kicker.textContent = 'Daily Watchlist · A-Shares';
  if (sub) sub.textContent = '按 A 股 list 当日涨跌和换手。不套用美股 Cycle / 价位图。点卡片打开估值。足迹不是预测，不是下单。';
  if (!cn || cn.empty || cn.ok === false) {
    title.textContent = 'A股每日观察';
    meta.innerHTML = '';
    grid.innerHTML = cnWatchHtml(cn);
    side.innerHTML = `<ul>
      <li>只看 A 股 list 公开行情。</li>
      <li>不套用美股价格周期。</li>
      <li>偏多 / 偏空是当日相对强弱。</li>
    </ul>`;
    status.textContent = cn?.error
      ? `A股观察板失败：${cn.error}`
      : (cn?.note || '今日还没有 A 股观察。点「扫描并写入」。');
    bindWatchCards(grid);
    return;
  }
  title.textContent = `${cn.date} A股观察`;
  meta.innerHTML = [
    ['市场', 'A股'],
    ['扫描', cn.scanned ?? '—'],
    ['偏多', cn.counts?.up ?? 0],
    ['偏空', cn.counts?.down ?? 0]
  ].map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  grid.innerHTML = cnWatchHtml(cn);
  side.innerHTML = `<p class="watch-kicker">Reminders</p>
    <h3>A股足迹</h3>
    <ul>
      <li>按 list 当日涨跌和换手。</li>
      <li>不是目标价，不是下单。</li>
      <li>不套用美股 Cycle。</li>
    </ul>
    <p class="watch-foot">${cn.note || ''}</p>`;
  status.textContent = `${cn.date} A股 · 扫描 ${cn.scanned} · ${(cn.lists || []).map((row) => row.title).join(' / ') || 'list'}。`;
  bindWatchCards(grid);
}

function renderWatch() {
  setWatchMarket(watchState.market);
  if (watchState.market === 'cn') renderCnWatch(watchState.cn);
  else renderUsWatch(watchState.us);
  const pack = watchState[watchState.market];
  document.getElementById('watchFreshness').innerHTML = freshnessHtml(pack, watchState.market);
  const status = document.getElementById('watchStatus');
  if (pack?.ok && !pack.empty && !pack.listError) status.textContent = '已读取保存的观察记录。';
}

let watchUpdating = false;
let watchRequestId = 0;
export async function loadWatchlist({ refresh = false, market } = {}) {
  if (watchUpdating) return;
  if (market) setWatchMarket(market);
  const requestId = ++watchRequestId;
  const cn = watchState.market === 'cn';
  const status = document.getElementById('watchStatus');
  const button = document.getElementById('watchRefreshBtn');
  const marketButtons = document.querySelectorAll('[data-watch-market]');
  if (refresh) {
    watchUpdating = true;
    button.disabled = true;
    button.textContent = '更新中…';
    marketButtons.forEach((item) => { item.disabled = true; });
  }
  if (status) {
    status.textContent = refresh
      ? (cn ? '正在按 A 股 list 拉公开行情并写入。' : '正在扫美股全 list 并写每日观察。日线较多，可能要一两分钟。')
      : (cn ? '正在读取 A 股观察板。' : '正在读取已保存的美股观察与验证报告；不自动全量扫描。');
  }
  const url = `${cn ? '/api/watchlist/cn' : '/api/watchlist'}${refresh ? '/run' : ''}`;
  try {
    const [pack, validation] = await Promise.all([
      fetch(url, { method: refresh ? 'POST' : 'GET' }).then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.error || (refresh && data.ok === false)) throw new Error(data.message || data.error || data.note || `HTTP ${response.status}`);
        return data;
      }),
      cn ? Promise.resolve(null) : fetch('/api/strategy/validation').then((r) => r.json()).catch(() => null)
    ]);
    if (requestId !== watchRequestId) return pack;
    if (!cn) pack.validation = validation;
    if (cn) watchState.cn = pack;
    else watchState.us = pack;
    renderWatch();
    if (refresh) status.textContent = `${watchFreshness(pack, cn ? 'cn' : 'us').stale ? '扫描已完成，但数据仍过期或日期不完整。' : '扫描已完成并保存。'}${status.textContent}`;
    return pack;
  } catch (error) {
    if (requestId === watchRequestId) {
      renderWatch();
      status.textContent = `${refresh ? '手动更新' : '读取观察板'}失败：${error.message}。保留已显示的观察板，可点「手动更新」重试。`;
    }
  } finally {
    if (refresh) {
      watchUpdating = false;
      button.disabled = false;
      button.textContent = '手动更新';
      marketButtons.forEach((item) => { item.disabled = false; });
    }
  }
}

export function bindWatchUi() {
  setWatchMarket(watchState.market);
  setInterval(() => {
    const panel = document.getElementById('panel-watch');
    if (!document.hidden && panel && !panel.hidden) document.getElementById('watchFreshness').innerHTML = freshnessHtml(watchState[watchState.market], watchState.market);
  }, 60000);
  document.getElementById('watchMarket')?.addEventListener('click', (event) => {
    const market = event.target.closest('[data-watch-market]')?.dataset.watchMarket;
    if (!market || market === watchState.market) return;
    loadWatchlist({ market }).catch((error) => {
      const status = document.getElementById('watchStatus');
      if (status) status.textContent = `观察板载入失败：${error.message}`;
    });
  });
  document.getElementById('watchGrid')?.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-watch-filter]')?.dataset.watchFilter;
    if (!WATCH_FILTERS.some(([id]) => id === filter) || filter === watchFilter) return;
    watchFilter = filter;
    renderWatch();
  });
  document.getElementById('watchRefreshBtn')?.addEventListener('click', () => {
    loadWatchlist({ refresh: true }).catch((error) => {
      const status = document.getElementById('watchStatus');
      if (status) status.textContent = `扫描失败：${error.message}`;
    });
  });
}
