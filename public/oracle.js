const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));
const state = { pack: null, symbols: null, busy: false, market:'us', qimenDate: '', qimenBusy: false, qimenMode: 'current' };

function renderAccuracy(p) {
  const s=p?.summary;
  const box = $('oracleAccuracy');
  if (!s?.all?.n) {
    if (box) { box.hidden = true; box.innerHTML = ''; }
    return;
  }
  if (box) box.hidden = false;
  const pct=n=>n==null?'暂无已结算样本':`${n.toFixed(1)}%`;
  const labels={locked:'已结算',pending:'待收盘',missing:'缺本日日线',neutral:'观望 · 不计分',excluded:'排除'};
  const side={up:'偏涨',down:'偏跌',neutral:'观望'};
  $('oracleAccuracy').innerHTML=`<h3>${esc(p.marketLabel || "美股")}卦象方向正确率 <small>仅本市场 · 当日开盘 → 收盘</small></h3><p>留存截止 ${esc(p.cutoffLabel)} · 可结算时间 ${esc(p.closeLabel)}</p><div class="oracle-overview">${[['总正确率',s.all],['偏涨正确率',s.up],['偏跌正确率',s.down]].map(([title,g])=>`<div><span>${title}</span><strong>${pct(g.rate)}</strong><small>${g.hits} / ${g.n} 命中 · ${g.days} 个交易日</small></div>`).join('')}<div><span>样本状态</span><strong>待结算 ${s.pending} · 缺行情 ${s.missing}</strong><small>观望 ${s.neutral} · 排除 ${s.excluded}</small></div></div><p>${esc(p.note)}</p><p>所选日 ${esc(p.selected.date)}：${p.selected.recordedAt?`已于 ${stamp(p.selected.recordedAt)} 留存 ${p.selected.count} 个标的`:'尚无盘前留存，当前回算不算预测样本'}。最近结算结果更新 ${stamp(p.updatedAt)}。</p>${p.capture?`<p>${esc(p.capture)}</p>`:''}${p.nextTrackableDate?`<button type="button" class="text-btn" data-oracle-track="${esc(p.nextTrackableDate)}">留存 ${esc(p.nextTrackableDate)} 卦象并更新统计</button>`:''}${s.all.interval95?`<p class="muted">95% 描述区间 ${s.all.interval95.map(n=>n.toFixed(1)+'%').join('–')}；同日标的相关，不能视作独立预测证据。相同已结算样本全部看涨 ${pct(s.baseline.up)} / 全部看跌 ${pct(s.baseline.down)}。</p>`:'<p class="muted">无样本显示未知，不按 0% 或 100% 计算；此前未留存的历史卦象不会回填。</p>'}${p.errors.length?`<p class="option-alert">${esc(p.errors.join('；'))}</p>`:''}<details><summary>逐笔方向与行情依据 · 累计 ${p.records.length} 条</summary><div class="table-wrap"><table><thead><tr><th>观察日 / 标的</th><th>盘前判断</th><th>开盘 → 收盘</th><th>结果 / 原因</th></tr></thead><tbody>${p.records.slice(0,100).map(r=>`<tr><td>${esc(r.date)} · ${esc(r.symbol)}<small>留存 ${stamp(r.recordedAt)}</small></td><td>${side[r.direction]||'未知'}</td><td>${money(r.open)} → ${money(r.close)}<small>${r.changePct==null?'未验证':`${r.changePct.toFixed(2)}%`} · ${esc(r.source||'行情未取得')}</small></td><td>${labels[r.status]||'未知'}${r.hit==null?'':r.hit?' · 命中':' · 未命中'}<small>${esc(r.reason)}</small></td></tr>`).join('')||'<tr><td colspan="4">还没有盘前留存。可使用上方留存按钮开始积累。</td></tr>'}</tbody></table></div>${p.records.length>100?'<p>展示最近 100 条，顶部统计包含全部记录。</p>':''}</details>`;
}

function hexSvg(hex, moving) {
  return `<svg viewBox="0 0 108 90" role="img" aria-label="${esc(hex.label)}">${[...hex.lines].reverse().map((line,i)=>{
    const y=8+i*13, color=6-i===moving?'#a34517':'currentColor';
    return line?`<rect x="8" y="${y}" width="92" height="6" fill="${color}"/>`:`<path d="M8 ${y+3}h38m16 0h38" stroke="${color}" stroke-width="6"/>`;
  }).join('')}</svg>`;
}
function renderSymbols(pack) {
  const groups=[['up','卦象偏涨','生扶之象较多'],['down','卦象偏跌','克泄之象较多'],['neutral','分歧 / 观望','方向相反或依据不足']];
  $('oracleSymbols').innerHTML=`<p><strong>${esc(pack.marketLabel || "美股")} · ${esc(pack.date)} · 卦象关注名单</strong> · ${pack.rows.length} 个标的 · 本次生成 ${stamp(pack.generatedAt)}</p><p class="muted">${esc(pack.note)} ${esc(pack.scope)}</p>${pack.retrospective?'<p class="option-alert">历史日期回算：以下按当前观察池和规则生成，不是当时留存的推荐，也不能算预测命中。</p>':''}${!pack.sessionDay?`<p class="option-alert">${pack.calendarSupported===false?'该年度交易日历未核实，暂不建立正确率样本。':'所选日期为非交易日；以下仅为该日卦象，不能视为当日交易信号。'}</p>`:''}<div class="oracle-symbol-groups">${groups.map(([key,label,note])=>`<section><h3>${label}<span>${pack.counts[key]} 个</span></h3><p class="muted">${note}</p>${pack.rows.filter(r=>r.direction===key).map(r=>`<details class="oracle-symbol-card"><summary><strong>${esc(r.symbol)}${state.market==='cn'?` · ${esc(r.name)}`:''}</strong><span>${esc(r.original.label)}</span><small>${esc(r.start.label)} → ${esc(r.end.label)} · 第 ${r.movingLine} 爻动</small></summary><p>${esc(r.reason)}</p><div class="oracle-hex-pair"><figure>${hexSvg(r.original,r.movingLine)}<figcaption>本卦 · 橙色为动爻</figcaption></figure><figure>${hexSvg(r.changed)}<figcaption>变卦 · ${esc(r.changed.label)}</figcaption></figure></div><p>体卦 ${esc(r.body.name+r.body.element)} · 用卦 ${esc(r.use.name+r.use.element)}<br>互卦 ${esc(r.mutual.label)}（过程参考）</p><small>爻位自下向上计数 · 固定种子 ${esc(r.seed)}</small></details>`).join('')||'<p>本日没有此类卦象；不强行补足名单。</p>'}</section>`).join('')}</div>`;
  $('oracleMethod').innerHTML=`<p>${esc(pack.methodology.replace("美东观察日",pack.market==='cn'?"北京观察日":"美东观察日"))}</p><p>方法版本 ${esc(pack.method)} · 不输出目标价、仓位或上涨概率。</p><p>${pack.sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join(' · ')}</p><p>参考资料支持传统卦象含义，不证明其能预测股票。本页面的代码取数与涨跌分组是自定义规则。</p>`;
}

const GRADE = {
  hit: { label: '吻合', cls: 'pos' },
  partial: { label: '部分吻合', cls: 'wait' },
  miss: { label: '不符', cls: 'neg' },
  pending: { label: '待对照', cls: '' }
};

function stamp(ts, market=state.market) {
  if (!ts || !Number.isFinite(new Date(ts).getTime())) return '—';
  return new Date(ts).toLocaleString('zh-CN', { timeZone: market==='cn'?'Asia/Shanghai':'America/New_York', hour12: false }) + (market==='cn'?' 北京时间':' ET');
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(2);
}

function gradeOf(row) {
  return GRADE[row?.grade] || GRADE.pending;
}

function pathSvg(pack) {
  const W = 720;
  const H = 220;
  const pad = 28;
  const open = pack.session?.open;
  const close = pack.session?.close;
  if (!(open > 0) && !(close > 0)) return '';
  const x = (ts) => pad + ((ts - open) / Math.max(close - open, 1)) * (W - pad * 2);
  const points = pack.path || [];
  const lo = points.length ? Math.min(...points.map((p) => p.low ?? p.close)) : 0;
  const hi = points.length ? Math.max(...points.map((p) => p.high ?? p.close)) : 1;
  const span = hi - lo || 1;
  const yPx = (px) => pad + (1 - (px - lo) / span) * (H - pad * 2);
  const yIdea = (y) => pad + (1 - y) * (H - pad * 2);
  const bands = (pack.phases || []).map((phase, i) => {
    if (!phase.window) return '';
    const x1 = x(phase.window.start);
    const x2 = x(phase.window.end);
    const fill = ['#d9c7a1', '#c9d6c3', '#e4d3c4', '#cfd9c8', '#ddd4c6'][i % 5];
    return `<rect x="${x1.toFixed(1)}" y="${pad}" width="${Math.max(x2 - x1, 0).toFixed(1)}" height="${H - pad * 2}" fill="${fill}" opacity="0.35"/>
      <text x="${((x1 + x2) / 2).toFixed(1)}" y="18" text-anchor="middle" font-size="11" fill="#66705f">${esc(phase.label)}</text>`;
  }).join('');
  const idea = (pack.schematic || []).map((pt, i) => `${i ? 'L' : 'M'}${x(open + pt.t * (close - open)).toFixed(1)} ${yIdea(pt.y).toFixed(1)}`).join(' ');
  const actual = points.map((pt, i) => `${i && pt.ts - points[i-1].ts === 300000 ? 'L' : 'M'}${x(pt.ts).toFixed(1)} ${yPx(pt.close).toFixed(1)}`).join(' ');
  const nowX = pack.session?.live ? x(Date.now()) : null;
  const ticks = ['09:30', '11:00', '13:00', '15:00', '16:00'].map((hm) => {
    const [h, m] = hm.split(':').map(Number);
    const ts = open + ((h * 60 + m) - 570) * 60000;
    if(ts>close)return '';
    return `<text x="${x(ts).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#66705f">${hm}</text>`;
  }).join('');
  return `<svg class="oracle-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="SPY 分时对照奇门五段路径">
    ${bands}
    ${points.length ? `<text x="${pad}" y="${pad+16}" fill="currentColor" font-size="12">最高 ${money(hi)} · 最低 ${money(lo)} USD</text>` : '<text x="360" y="110" text-anchor="middle" fill="currentColor">暂无该日完整 K 线</text>'}
    ${actual ? `<path d="${actual}" fill="none" stroke="currentColor" stroke-width="2"/>` : ''}
    ${nowX != null ? `<line x1="${nowX}" x2="${nowX}" y1="${pad}" y2="${H - pad}" stroke="#a33b32" stroke-dasharray="3 3"/>` : ''}
    ${ticks}
  </svg><p class="muted">实线：所选日 SPY 完整 5 分钟 K 线收盘价（美元），行情缺口不连线。色带：原文时段。</p><details><summary>查看原盘面示意路径（无价格尺度）</summary><svg class="oracle-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="原盘面概念示意，非预测价格">${idea ? `<path d="${idea}" fill="none" stroke="currentColor" stroke-dasharray="5 4"/>` : ""}${ticks}</svg><p>示意线只表达原文节奏，不与实际价格共用纵轴，不代表目标价。</p></details>`;
}

function renderEmpty(pack) {
  $('oracleFreshness').innerHTML = '';
  $('oracleVerdict').innerHTML = `<div class="option-alert"><strong>这一天还没有盘面</strong><p>${esc(pack.note || '')}</p><p>点「保存奇门对照」会为今天用 qimen-current 自动起盘并写入。更早的日期不回填，刷新也不会把旧盘改成今天。</p>${pack.dates?.length?`<button type="button" class="text-btn" data-qimen-latest="${esc(pack.dates[0])}">查看最近盘面 · ${esc(pack.dates[0])}</button>`:''}</div>`;
  $('oraclePalaces').innerHTML = '';
  $('oracleNotes').innerHTML = '';
  $('oraclePath').innerHTML = '';
  $('oraclePhases').innerHTML = '';
}

function render(pack) {
  if (pack.empty) {
    renderEmpty(pack);
    return;
  }
  const g = gradeOf(pack.overall?.bias);
  const live = pack.session?.live ? '盘中对照' : pack.session?.closed ? '收盘对照' : '开盘前';
  $('oracleFreshness').innerHTML = `<div class="option-alert"><strong>${esc(pack.freshness?.reason || '非实时 · 历史盘面对照')}</strong><p>${esc(pack.date)} · ${esc(pack.overall?.headline || pack.title)}</p><p>${esc(live)} · ${esc(pack.instrument?.symbol || 'SPY')} 代理 ${esc(pack.instrument?.proxyFor || 'SPX')} · 来源 ${esc(pack.session?.source || '无')} · 本日最后完整 K 线收盘 ${money(pack.session?.last)} · K 线开始时间 ${stamp(pack.session?.lastBarAt,'us')}</p><p>非实时行情；仅对照所选日期，不把抓取时间当作报价更新。${esc(pack.session?.error || pack.note)}</p></div>`;
  $('oracleFreshness').innerHTML += `<details class="oracle-method"><summary>盘面来源与完整性 · 原始录入，待核实</summary><p>盘面日期 ${esc(pack.date)} · 来源 ${esc(pack.provenance?.source || pack.source || '未记录')} · 原始留存时间 ${pack.provenance?.recordedAt ? stamp(pack.provenance.recordedAt,'us') : '未记录，不能证明盘前留存'}。</p><p>本次对照计算 ${stamp(pack.judgedAt,'us')} · 全日行情覆盖 ${pack.session?.coverage?.received ?? 0}/${pack.session?.coverage?.expected ?? '—'} 根。</p><p>${esc(pack.provenance?.note || '')}</p><p>多项星神标签沿用原始摘录，尚未区分天盘、地盘与八神；缺失项目显示未知。</p></details>`;
  $('oracleVerdict').innerHTML = `<div class="oracle-overview">
    <div><span>倾向</span><strong>${esc(pack.bias)}</strong><small class="${g.cls}">${g.label} · ${esc(pack.overall?.bias?.reason || '')}</small></div>
    <div><span>先抑后扬</span><strong class="${gradeOf(pack.overall?.first).cls}">${gradeOf(pack.overall?.first).label}</strong><small>${esc(pack.overall?.first?.reason || '')}</small></div>
    <div><span>历史时段吻合 · 非预测正确率</span><strong>${pack.overall?.scored ? `${pack.overall.hits} / ${pack.overall.scored}` : "暂无可计分时段"}</strong><small>共 ${pack.overall?.total ?? 0} 段 · 部分吻合不算命中</small></div>
    <div><span>口诀</span><strong>${esc((pack.rules || []).join(' · '))}</strong><small>${esc(pack.overall?.dump?.reason || '')}</small></div>
  </div>`;
  $('oraclePalaces').innerHTML = `<h3>九宫原始摘录</h3><p class="muted">按原文件宫位排列 · 高亮用神宫 · 展开查看字段</p><div class="oracle-luoshu">${(pack.chart?.palaces || []).map((cell) => `
    <article class="oracle-cell ${cell.yong || cell.id === pack.chart?.palaceId ? 'is-yong' : ''}">
      <p class="kicker">${esc(cell.bagua)}${cell.num}宫</p>
      <h3>${esc(cell.men)}</h3>
      <p>${esc((cell.stars || []).join(' · '))}</p>
      ${cell.yong || cell.id === pack.chart?.palaceId ? `<p class="oracle-yong">${esc(pack.chart?.yongShen || '未记录')} 用神 · 时干 ${esc(pack.chart?.shiGan || '未记录')}</p>` : ''}<details><summary>宫位字段</summary><small>门：${esc(cell.men || '未记录')}<br>原文星神标签：${esc((cell.stars || []).join('、') || '未记录')}<br>天盘干：${esc(cell.heavenStem || '未记录')}<br>地盘干：${esc(cell.earthStem || '未记录')}<br>八神：${esc(cell.deity || '未记录')}</small></details>
      ${cell.note ? `<small>${esc(cell.note)}</small>` : ''}
    </article>`).join('')}</div>`;
  $('oracleNotes').innerHTML = `<h3>原盘面倾向与依据</h3><ul>${(pack.analysis || []).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    <h3>节奏</h3><ol>${(pack.rhythm || []).map((line) => `<li>${esc(line)}</li>`).join('')}</ol>
    <h3>关注窗</h3><ul>${(pack.watchWindows || []).map((w) => `<li>${esc(w.label)} → ${esc(w.startEt)}–${esc(w.endEt)} ET</li>`).join('')}</ul>
    <p class="muted">${esc((pack.risks || []).join(' '))}</p>`;
  $('oraclePath').innerHTML = pathSvg(pack);
  $('oraclePhases').innerHTML = `<table><thead><tr><th>时段</th><th>纽约时间</th><th>对照</th><th>说明</th></tr></thead><tbody>
    ${(pack.phases || []).map((row) => {
      const gg = gradeOf(row);
      const px = row.stats ? `${money(row.stats.open)} → ${money(row.stats.close)}` : '—';
      return `<tr class="${pack.overall?.current === row.id ? 'is-active' : ''}"><td>${esc(row.label)}<small>${esc(px)}</small></td><td>${esc(row.start)}–${esc(row.end)}</td><td class="${gg.cls}">${gg.label}</td><td>${esc(row.reason)}<small>${row.coverage ? `完整 K 线 ${row.coverage.received}/${row.coverage.expected} 根` : ""}</small><details><summary>判定规则</summary>${esc(row.criterion || "无有效规则")}</details></td></tr>`;
    }).join('')}
  </tbody></table>`;
}

async function fetchOracle(url, options={}, timeout=45000) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch(url,{cache:'no-store',...options,signal:controller.signal});
    const pack=await response.json();
    if(!response.ok || pack.ok===false)throw Error(pack.error || pack.note || `HTTP ${response.status}`);
    return pack;
  } catch(error) { if(error.name==='AbortError')throw Error('请求超时，请重试；按钮已恢复');throw error; }
  finally {clearTimeout(timer);}
}

async function loadOracle({refresh=false}={}) {
  if(state.busy)return;
  state.busy=true;
  const ids=['oracleMarket','oracleRefreshBtn','oracleDate','oracleTodayBtn'];
  ids.forEach(id=>$(id).disabled=true);
  if(!state.pack && !state.qimenBusy)loadQimen();
  $('oracleStatus').textContent='正在读取股票卦象和正确率；奇门区可独立刷新…';
  try {
    const query=new URLSearchParams({market:state.market,...($('oracleDate').value?{date:$('oracleDate').value}:{})});
    const [symbols,accuracy]=await Promise.allSettled([
      fetchOracle(`/api/oracle/symbols?${query}`),
      fetchOracle(`/api/oracle/accuracy?${query}`,{method:refresh?'POST':'GET'},60000)
    ]);
    const notices=[];
    if(symbols.status==='fulfilled') {
      state.symbols=symbols.value;renderSymbols(state.symbols);
      if(!$('oracleDate').value)$('oracleDate').value=state.symbols.date;
      notices.push(`${state.symbols.date} · ${state.symbols.rows.length} 个标的已读取`);
    } else notices.push(`卦象读取失败：${symbols.reason.message}`);
    if(accuracy.status==='fulfilled')renderAccuracy(accuracy.value);
    else {$('oracleAccuracy').textContent=`正确率读取失败：${accuracy.reason.message}`;notices.push('正确率暂不可用');}
    $('oracleStatus').textContent=notices.join('；');
  } finally {state.busy=false;ids.forEach(id=>$(id).disabled=false);$('oracleAccuracy').querySelectorAll('button').forEach(b=>b.disabled=false);}
}

function qimenControls() {
  const current=state.qimenMode==='current';
  ['oracleQimenMode','oracleQimenScope','oracleQimenRefresh','oracleQimenToday'].forEach(id=>$(id).disabled=state.qimenBusy);
  ['oracleQimenDate','oracleRecorded'].forEach(id=>$(id).disabled=state.qimenBusy || current);
  $('oracleQimenScope').hidden=!current;
  $('oracleWriteBtn').disabled=state.qimenBusy || current || !state.pack;
  $('oracleQimenRefresh').textContent=state.qimenBusy?'正在更新…':current?'按当前时间刷新九宫':'刷新历史盘行情';
}

async function loadQimen({refresh=false,write=false}={}) {
  if(state.qimenBusy)return;
  state.qimenBusy=true;qimenControls();
  const oldKey=state.pack?.chartKey;
  $('oracleQimenStatus').textContent=state.qimenMode==='current'?'正在按北京时间起盘并读取多市场观察池…':'正在读取历史原盘与行情…';
  try {
    const date=$('oracleQimenDate').value;
    const query=new URLSearchParams({...(date?{date}:{}),...(refresh?{refresh:'1'}:{})});
    const url=state.qimenMode==='current'?`/api/oracle/current?scope=${encodeURIComponent($('oracleQimenScope').value)}`:write?'/api/oracle/write':`/api/oracle?${query}`;
    const pack=await fetchOracle(url,write?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date})}:{},state.qimenMode==='current'?20000:45000);
    state.pack=pack;
    if(pack.mode==='current') {
      renderCurrentQimen(pack);
      $('oracleQimenStatus').textContent=`刷新成功 · ${stamp(pack.generatedAt,'cn')} · ${pack.rows.length} 个观察标的${oldKey===pack.chartKey?' · 仍在同一小时，盘面保持一致':''}`;
    } else {
      state.qimenDate=pack.date;$('oracleQimenDate').value=pack.date;
      $('oracleRecorded').innerHTML='<option value="">选择已录入日期</option>'+(pack.dates||[]).map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
      $('oracleRecorded').value=(pack.dates||[]).includes(pack.date)?pack.date:'';
      render(pack);
      $('oracleQimenStatus').textContent=write?(pack.generatedChart?'已用 qimen-current 生成今天的盘并保存。':'已保存历史研究对照。'):`${pack.date} · ${pack.empty?'没有该日手工原盘。保存会为今天用 qimen-current 自动起盘；更早的日期不回填':`行情 ${pack.session?.barCount || 0} 根完整 K 线`}`;
    }
  } catch(error) {
    if(!write){state.pack=null;renderEmpty({note:`读取失败：${error.message}；请点击刷新重试。`});}
    $('oracleQimenStatus').textContent=`更新失败：${error.message}`;
  } finally {state.qimenBusy=false;qimenControls();}
}

function renderCurrentQimen(pack) {
  $('oracleFreshness').innerHTML=`<div class="option-alert"><strong>当前自动盘 · ${esc(pack.ju)}</strong><p>实际刷新 ${stamp(pack.generatedAt,'cn')} · 排盘采用 ${stamp(pack.effectiveAt,'cn')} · ${esc(pack.pillars.join(' / '))}</p><p>${esc(pack.chief)}</p><p>${esc(pack.note)}</p></div>`;
  $('oracleVerdict').innerHTML=`<div class="oracle-overview">${[['up','卦象偏涨'],['down','卦象偏跌'],['neutral','分歧 / 观望']].map(([k,t])=>`<div><span>${t}</span><strong>${pack.counts[k]} 个</strong><small>按标的对应宫位的门类分组</small></div>`).join('')}</div><p class="muted">${esc(pack.timeLabel || '北京时间')}起局 · 美股观察日 ${esc(pack.observationTimeLabel || '美东')} · 美股 ${pack.usCount ?? '—'} / 全部 ${pack.universeCount ?? pack.rows.length}</p>`;
  $('oraclePalaces').innerHTML=`<h3>当前九宫 · 高亮时干所在宫</h3><div class="oracle-luoshu">${pack.chart.palaces.map(c=>`<article class="oracle-cell ${c.yong?'is-yong':''}"><p class="kicker">${esc(c.bagua)} ${c.num} 宫</p><h3>${esc(c.men)}</h3><p>${esc(c.stars.join(' · '))} · ${esc(c.deity)}</p><p>天盘 ${esc(c.heavenStem)} / 地盘 ${esc(c.earthStem)}</p>${c.yong?`<small>时干 ${esc(pack.chart.shiGan)} 参考宫</small>`:''}<small>${pack.rows.filter(r=>r.palaceId===c.id).length} 个标的映射至此宫</small></article>`).join('')}</div>`;
  $('oracleNotes').innerHTML=`<h3>怎么看当前盘</h3><p>同一时点共用一张时盘；每个标的按固定规则落到不同宫位。这里包括指数、跨资产 ETF 和已有美股 / A 股观察池。</p><p>${esc(pack.accuracyNote)}</p><details class="oracle-method"><summary>起局与标的映射规则</summary><p>${esc(pack.methodology)}</p><p>${pack.sources.map(r=>`<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>`).join(' · ')}</p><p>卦象分组是娱乐研究，不构成买卖指令，不输出目标价或上涨概率。</p></details>${pack.errors.length?`<p class="option-alert">${esc(pack.errors.join('；'))}；以下仅展示成功读取的观察池。</p>`:''}`;
  $('oraclePath').innerHTML=`<h3>多标的卦象观察</h3><p class="muted">代码映射不是股价数据；新盘不复用 9 月 16 日 SPX 解读。展开可核对每个标的的宫位依据。</p><div class="oracle-symbol-groups">${[['up','卦象偏涨'],['down','卦象偏跌'],['neutral','分歧 / 观望']].map(([key,label])=>`<section><h3>${label} · ${pack.counts[key]}</h3>${pack.rows.filter(r=>r.direction===key).map(r=>`<details class="oracle-symbol-card"><summary><strong>${esc(r.symbol)} · ${esc(r.name)}</strong><small>${r.market==='cn'?'A 股':'美股'} · ${esc(r.palace)} · ${esc(r.men)}</small></summary><p>${esc(r.reason)}</p><p>九星 ${esc(r.star)} · 八神 ${esc(r.deity)}<br>天盘 ${esc(r.heavenStem)} · 地盘 ${esc(r.earthStem)}</p></details>`).join('')||'<p>本次没有此类标的。</p>'}</section>`).join('')}</div>`;
  const leanName = { up: '偏涨宫更多', down: '偏跌宫更多', neutral: '涨跌宫相当' };
  const sectors = pack.sectors || [];
  $('oraclePhases').innerHTML = sectors.length ? `<h3>板块对照</h3><p class="muted">同一张时盘，按板块把已经映射的标的放在一起数。这不是另起一局，也不写未来一个月的阶段或目标价。</p><div class="oracle-symbol-groups">${sectors.map((sector) => `<section><h3>${esc(sector.name)} · ${leanName[sector.lean] || '观望'}</h3><p class="muted">偏涨 ${sector.up} · 偏跌 ${sector.down} · 观望 ${sector.neutral}</p>${sector.members.map((row) => `<p><strong>${esc(row.symbol)}</strong> <small>${esc(row.palace)} · ${esc(row.men)} · ${row.score > 0 ? '+' : ''}${esc(row.score)}</small></p>`).join('')}</section>`).join('')}</div>` : '';
}

export function bindOracleUi() {
  setInterval(()=>{
    if(state.pack?.mode!=='current' || state.qimenBusy)return;
    const stale=Date.now()>=Date.parse(state.pack.refreshAfter);
    const banner=$('oracleFreshness').querySelector('[data-qimen-stale]');
    if(stale && !banner)$('oracleFreshness').insertAdjacentHTML('afterbegin','<p class="option-alert" data-qimen-stale><strong>已到下一整点，当前展示的是上次起盘结果，请点击“按当前时间刷新九宫”。</strong></p>');
  },30000);
  $('oracleMarket')?.addEventListener('change',()=>{
    state.market=$('oracleMarket').value;state.symbols=null;$('oracleDate').value='';
    $('oracleSymbols').textContent='正在读取所选市场观察池…';$('oracleAccuracy').textContent='正在读取所选市场正确率…';$('oracleMethod').textContent='';
    loadOracle();
  });
  $('oracleAccuracy')?.addEventListener('click',event=>{const button=event.target.closest('[data-oracle-track]');if(button&&!state.busy){button.disabled=true;$('oracleDate').value=button.dataset.oracleTrack;loadOracle({refresh:true});}});
  $('oracleRefreshBtn')?.addEventListener('click', () => loadOracle({refresh:true}));
  $('oracleTodayBtn')?.addEventListener('click', () => { $('oracleDate').value=''; loadOracle({refresh:true}); });
  $('oracleRecorded')?.addEventListener('change', () => { if($('oracleRecorded').value) { $('oracleQimenDate').value=$('oracleRecorded').value; loadQimen(); } });
  $('oracleQimenDate')?.addEventListener('change',()=>loadQimen());
  $('oracleQimenRefresh')?.addEventListener('click',()=>loadQimen({refresh:true}));
  $('oracleQimenToday')?.addEventListener('click',()=>{state.qimenMode='current';$('oracleQimenMode').value='current';loadQimen({refresh:true});});
  $('oracleQimenMode')?.addEventListener('change',()=>{state.qimenMode=$('oracleQimenMode').value;loadQimen();});
  $('oracleQimenScope')?.addEventListener('change',()=>loadQimen());
  $('oracleVerdict')?.addEventListener('click',event=>{const button=event.target.closest('[data-qimen-latest]');if(button){$('oracleQimenDate').value=button.dataset.qimenLatest;loadQimen();}});
  $('oracleWriteBtn')?.addEventListener('click', () => loadQimen({write:true}));
  $('oracleDate')?.addEventListener('change', () => loadOracle());
}

export { loadOracle };
