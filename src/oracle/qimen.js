import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_ORACLE, todayStamp } from '../paths.js';
import { sessionOpenMs } from '../market-time.js';
import { regularSession, sessionCloseMs } from '../options/time.js';
import { loadChart } from '../options/market.js';
import { validOracleDay } from './symbols.js';
import { currentQimenChart } from './qimen-current.js';

export const ORACLE_NOTE = '奇门对照是研究/娱乐，不是下单指令。不写进推荐操作 / 模拟操作 / 实际操作。缺文件不让每日任务失败。用 SPY 5 分钟 K 对照 SPX 盘面。';

const PALACES = [
  { id: 'xun', num: 4, bagua: '巽', men: '杜门', stars: ['天辅', '天芮'] },
  { id: 'li', num: 9, bagua: '离', men: '景门', stars: ['天英', '天柱'], note: '值符天冲 · 值使伤门 · 波动放大、急冲、争夺' },
  { id: 'kun', num: 2, bagua: '坤', men: '死门', stars: ['天禽', '天心'] },
  { id: 'zhen', num: 3, bagua: '震', men: '伤门', stars: ['天冲', '天任'] },
  { id: 'zhong', num: 5, bagua: '中', men: '开门', stars: ['天任', '天蓬'], note: '日干参考' },
  { id: 'dui', num: 7, bagua: '兑', men: '惊门', stars: ['天柱', '天辅'], yong: true, note: '早盘易冲高，但上方承压' },
  { id: 'gen', num: 8, bagua: '艮', men: '生门', stars: ['天任', '天禽'], note: '开盘不差，偏强或先反抽' },
  { id: 'kan', num: 1, bagua: '坎', men: '休门', stars: ['天蓬', '天心'] },
  { id: 'qian', num: 6, bagua: '乾', men: '休门', stars: ['玄武', '天心'], note: '尾盘参考 · 结果面反复，尾盘更易震荡' }
];

/** 盘面时间轴按美股 9:30–16:00 纽约时间；原文关注窗写的是 CDT，对照时换算成 ET。 */
export const SPX_2026_09_16 = {
  type: 'qimen-spx-reading',
  date: '2026-09-16',
  liveTrading: false,
  draft: true,
  source: 'user-chart',
  title: 'SPX 奇门 · 时干丁落兑七宫',
  instrument: { symbol: 'SPY', proxyFor: 'SPX', note: 'Yahoo/Nasdaq SPY 5 分钟 K，不是 SPX 期货。' },
  chart: {
    shiGan: '丁',
    yongShen: 'SPX',
    palace: '兑七宫',
    palaceId: 'dui',
    men: '惊门',
    palaces: PALACES
  },
  bias: '震荡偏多、先抑后扬',
  rules: ['高处不追', '低处不慌', '顺势而行'],
  analysis: [
    '时干丁为 SPX 用神，落兑七宫。',
    '兑七宫见惊门：波动不小，盘中易先冲后压。',
    '开盘条件并不差；若低开，反而更容易回拉。',
    '上午中后段多头力量逐步增强；午盘前后有分歧与回踩。',
    '下午若突破上午高点，容易再走一段上冲；未突破则偏高位震荡。'
  ],
  rhythm: [
    '开盘：方向感不强，先上下扫盘；低开偏向回拉。',
    '上午中后段：多头增强，倾向向上修复或冲高。',
    '午盘附近：分歧加大，可冲高回落，暂不偏单边大跌。',
    '下午：突破上午高点则再冲；否则高位震荡。',
    '尾盘：最后一小时反复，不宜追涨，注意回吐。'
  ],
  risks: [
    '偏空风险：上午冲高后回落幅度扩大。',
    '若早盘直接大幅高开，更要防冲高回落。'
  ],
  watchWindows: [
    { label: '盘面写 CDT 9:30–11:00', tz: 'America/Chicago', startCdt: '09:30', endCdt: '11:00', startEt: '10:30', endEt: '12:00' },
    { label: '盘面写 CDT 13:30–14:45', tz: 'America/Chicago', startCdt: '13:30', endCdt: '14:45', startEt: '14:30', endEt: '15:45' }
  ],
  phases: [
    { id: 'open', label: '开盘震荡', start: '09:30', end: '10:10', expect: 'chop' },
    { id: 'dip', label: '探底回升', start: '10:10', end: '11:25', expect: 'dip-then-up' },
    { id: 'noon', label: '午间回踩', start: '11:25', end: '13:15', expect: 'pullback' },
    { id: 'push', label: '下午再冲', start: '13:15', end: '15:00', expect: 'rally' },
    { id: 'close', label: '尾盘震荡', start: '15:00', end: '16:00', expect: 'chop-fade' }
  ],
  schematic: [
    { t: 0, y: 0.58 }, { t: 0.08, y: 0.52 }, { t: 0.14, y: 0.28 }, { t: 0.28, y: 0.74 },
    { t: 0.42, y: 0.62 }, { t: 0.52, y: 0.48 }, { t: 0.62, y: 0.55 }, { t: 0.78, y: 0.88 },
    { t: 0.88, y: 0.7 }, { t: 1, y: 0.64 }
  ]
};

const BUILTIN = {
  [SPX_2026_09_16.date]: SPX_2026_09_16
};

export function hmOffsetMs(hm) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hm))) return null;
  const [h, m] = String(hm || '').split(':').map(Number);
  if (![h, m].every(Number.isFinite)) return null;
  return ((h * 60 + m) - (9 * 60 + 30)) * 60000;
}

export function windowMs(day, start, end) {
  const open = sessionOpenMs(day);
  const startOff = hmOffsetMs(start);
  const endOff = hmOffsetMs(end);
  if (open == null || startOff == null || endOff == null || startOff < 0 || endOff <= startOff || startOff % 300000 || endOff % 300000) return null;
  const close = sessionCloseMs(day);
  if (open + startOff >= close) return null;
  return {
    start: open + startOff,
    end: end === '16:00' ? close : Math.min(open + endOff, close)
  };
}

function sessionBars(bars, day) {
  const seen = new Set();
  return (bars || []).filter((bar) => {
    const ts = Number(bar.ts);
    if (!(ts > 0) || (ts - sessionOpenMs(day)) % 300000 || seen.has(ts)) return false;
    if (![bar.open, bar.close, bar.high, bar.low].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) return false;
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return false;
    seen.add(ts);
    return todayStamp(new Date(ts)) === day && regularSession(ts);
  }).sort((a, b) => a.ts - b.ts);
}

function coverageOf(rows, start, end, now) {
  const expected = Math.max(0, (end - start) / 300000);
  const received = rows.length;
  return { expected, received, missing: Math.max(0, expected - received), complete: expected > 0 && received === expected && now >= end };
}

export const EXPECT_RULES = {
  chop: '振幅至少 0.12%，且净涨跌绝对值不超过振幅的一半。',
  'dip-then-up': '低点在前约 70% 的 K 线内，低点至收盘回升至少开盘价的 0.08%，且收盘不低于开盘。',
  pullback: '高点在前约 60% 的 K 线内，收盘低于高点，净涨幅不超过 0.08%。',
  rally: '净涨至少 0.10%，且高点不早于低点。仅检验上涨路径，不检验突破上午高点这一条件。',
  'chop-fade': '振幅至少 0.10%，且净涨跌绝对值不超过振幅的 55%。'
};

function barsIn(bars, start, end) {
  return bars.filter((bar) => bar.ts >= start && bar.ts < end);
}

function statsOf(rows) {
  if (!rows.length) return null;
  const open = rows[0].open;
  const close = rows.at(-1).close;
  if (!(open > 0) || !(close > 0)) return null;
  let high = -Infinity;
  let low = Infinity;
  let minIdx = 0;
  let maxIdx = 0;
  rows.forEach((bar, i) => {
    if (bar.high >= high) {
      high = bar.high;
      maxIdx = i;
    }
    if (bar.low <= low) {
      low = bar.low;
      minIdx = i;
    }
  });
  return {
    open,
    close,
    high,
    low,
    net: (close - open) / open,
    range: (high - low) / open,
    minIdx,
    maxIdx,
    n: rows.length,
    startTs: rows[0].ts,
    endTs: rows.at(-1).ts
  };
}

export function scoreExpect(expect, stats) {
  if (!stats) return { grade: 'pending', reason: '该时段尚未发生，或没有可用 K 线' };
  const { net, range, minIdx, maxIdx, n, open, close, low } = stats;
  if (expect === 'chop') {
    if (range < 0.0012) return { grade: 'partial', reason: '波动太小，谈不上盘面说的震荡' };
    if (Math.abs(net) <= range * 0.5) return { grade: 'hit', reason: `区间 ${(range * 100).toFixed(2)}%，净变 ${(net * 100).toFixed(2)}%，偏来回扫` };
    return { grade: 'miss', reason: `单边 ${(net * 100).toFixed(2)}%，大于震荡盘面` };
  }
  if (expect === 'dip-then-up') {
    const earlyLow = minIdx <= Math.max(1, Math.floor(n * 0.7));
    const recovered = (close - low) / open >= 0.0008;
    if (earlyLow && recovered && close >= open) return { grade: 'hit', reason: '先见低点后收回，收在时段开盘之上' };
    if (earlyLow && recovered) return { grade: 'partial', reason: '探底后有回升，但仍收在时段开盘之下' };
    if (earlyLow) return { grade: 'partial', reason: '低点偏早，但回升不够' };
    return { grade: 'miss', reason: '低点偏晚或没有探底回升' };
  }
  if (expect === 'pullback') {
    const earlyHigh = maxIdx <= Math.floor(n * 0.6);
    if (earlyHigh && close < stats.high && net <= 0.0008) return { grade: 'hit', reason: '高点偏前，随后回踩' };
    if (net < 0) return { grade: 'partial', reason: '有回落，但高点不在前半段' };
    return { grade: 'miss', reason: '没有午间回踩，更像续涨' };
  }
  if (expect === 'rally') {
    if (net >= 0.001 && maxIdx >= minIdx) return { grade: 'hit', reason: `净涨 ${(net * 100).toFixed(2)}%，符合再冲` };
    if (net > 0) return { grade: 'partial', reason: '有上涨，但力度弱于盘面的再冲' };
    return { grade: 'miss', reason: '下午没有上冲' };
  }
  if (expect === 'chop-fade') {
    if (range < 0.001) return { grade: 'partial', reason: '尾盘几乎走平' };
    if (Math.abs(net) <= range * 0.55) return { grade: 'hit', reason: '尾盘来回，没有单边追涨' };
    return { grade: 'miss', reason: `尾盘单边 ${(net * 100).toFixed(2)}%，不像反复` };
  }
  return { grade: 'pending', reason: '未知路径类型' };
}

export function scoreFirstDipThenRise(stats) {
  if (!stats || stats.n < 8) return { grade: 'pending', reason: '全日样本不足，还不能验「先抑后扬」' };
  if (stats.minIdx < stats.maxIdx && stats.close >= stats.open) {
    return { grade: 'hit', reason: '先见当日低点、后见高点，且收涨' };
  }
  if (stats.minIdx < stats.maxIdx) {
    return { grade: 'partial', reason: '时间上先抑后扬，但全日仍收跌' };
  }
  return { grade: 'miss', reason: '高点早于低点，不像先抑后扬' };
}

export function scoreBias(stats, first) {
  if (!stats || first.grade === 'pending') return { grade: 'pending', reason: '开盘后才能看「震荡偏多」' };
  const mild = Math.abs(stats.net) <= Math.max(stats.range * 0.7, 0.008);
  if (first.grade === 'hit' && stats.net >= 0 && mild) return { grade: 'hit', reason: '收涨且波幅不像单边趋势日' };
  if (stats.net >= 0 && mild) return { grade: 'partial', reason: '偏多或震荡有一边对，先抑后扬不完整' };
  if (first.grade === 'hit') return { grade: 'partial', reason: '先抑后扬在，但收盘不是偏多震荡' };
  return { grade: 'miss', reason: '和「震荡偏多、先抑后扬」对不上' };
}

function morningHighThenDump(bars, day) {
  const morning = windowMs(day, '09:30', '12:00');
  const rest = windowMs(day, '12:00', '16:00');
  if (!morning || !rest) return null;
  const am = statsOf(barsIn(bars, morning.start, morning.end));
  const pm = statsOf(barsIn(bars, rest.start, rest.end));
  if (!am || !pm) return null;
  const dump = (am.high - pm.low) / am.open;
  if (dump >= 0.006 && pm.low < am.high) {
    return { flagged: true, reason: `上午高点后回落 ${(dump * 100).toFixed(2)}%，正是盘面说的偏空风险` };
  }
  return { flagged: false, reason: '尚未出现「上午冲高后回落扩大」' };
}

export function judgeReading(reading, { bars = [], now = Date.now(), source = null, last = null, quoteAt = null } = {}) {
  const day = reading.date;
  const session = sessionBars(bars, day).filter(bar => bar.ts + 300000 <= now);
  const open = sessionOpenMs(day);
  const close = sessionCloseMs(day);
  const sessionDay = regularSession(open);
  const live = sessionDay && now >= open && now < close;
  const closed = now >= close;
  const phases = (reading.phases || []).map((phase) => {
    const win = windowMs(day, phase.start, phase.end);
    if (!win || !sessionDay) return { ...phase, grade: 'pending', status: 'unavailable', reason: '无有效交易时段（休市、提前收盘或时间无效）', stats: null, window: null };
    const started = now >= win.start;
    const rows = barsIn(session, win.start, win.end);
    const stats = started ? statsOf(rows) : null;
    const coverage = coverageOf(rows, win.start, win.end, now);
    const status = !started ? 'upcoming' : now < win.end ? 'live' : coverage.complete ? 'complete' : 'missing';
    const scored = coverage.complete ? scoreExpect(phase.expect, stats) : { grade: 'pending', reason: !started ? '时段尚未开始' : now < win.end ? '时段进行中，结束且 K 线齐全后再计分' : `缺少 ${coverage.missing} 根完整 5 分钟 K 线，暂不计分` };
    return { ...phase, ...scored, status, coverage, criterion: EXPECT_RULES[phase.expect] || '未定义判定规则', stats, window: win };
  });
  const dayStats = statsOf(session);
  const coverage = coverageOf(session, open, close, now);
  const pending = { grade: 'pending', reason: !sessionDay ? '无已核实交易时段' : !closed ? '全日尚未结束，暂不计分' : `全日行情 ${coverage.received}/${coverage.expected} 根，缺失时不计分` };
  const first = sessionDay && coverage.complete ? scoreFirstDipThenRise(dayStats) : pending;
  const bias = reading.bias === SPX_2026_09_16.bias ? scoreBias(dayStats, first) : { grade: 'pending', reason: '该倾向尚未定义评分规则' };
  if (first.grade === 'pending') Object.assign(bias, pending);
  const dump = coverage.complete ? morningHighThenDump(session, day) : null;
  const done = phases.filter((row) => row.grade !== 'pending');
  const hits = done.filter((row) => row.grade === 'hit').length;
  const current = phases.find((row) => row.window && now >= row.window.start && now < row.window.end) || null;
  let headline = '盘面已录入。美股开盘后再用 SPY 对照。';
  if (live && current) headline = `现在大约在「${current.label}」· ${gradeLabel(current.grade)}`;
  else if (closed) headline = `收盘对照 · ${done.length ? `${hits}/${done.length} 个已完成时段吻合` : '暂无可计分时段'} · ${phases.length - done.length} 段待对照`;
  else if (done.length) headline = `已过 ${done.length} 段 · 吻合 ${hits} · ${gradeLabel(bias.grade)}`;
  return {
    ...reading,
    liveTrading: false,
    judgedAt: new Date(now).toISOString(),
    provenance: {
      readingDate: day, source: reading.source || '未记录', recordedAt: reading.recordedAt || null,
      note: '原始盘面摘录，未核实完整排盘；缺起局时间、地点、排盘法、阴阳遁与局数时不补造。历史路径吻合不等于盘前预测正确率，也不计入上方股票方向统计。'
    },
    freshness: { historical: day < todayStamp(new Date(now)), reason: day < todayStamp(new Date(now)) ? `已过期：盘面日期 ${day}，当前美东观察日 ${todayStamp(new Date(now))}；仅供历史复盘` : '非实时：仅使用已完成的 5 分钟 K 线；刷新行情不会生成新盘面' },
    session: { open, close, live, closed, barCount: session.length, last: session.at(-1)?.close ?? null,
      lastBarAt: session.at(-1)?.ts ?? null, coverage, quoteAt: quoteAt && todayStamp(new Date(quoteAt)) === day ? quoteAt : null, source },
    path: session.map((bar) => ({ ts: bar.ts, close: bar.close, high: bar.high, low: bar.low })),
    phases,
    overall: { first, bias, dump, hits, scored: done.length, total: phases.length, current: current?.id || null, headline },
    note: ORACLE_NOTE
  };
}

export function gradeLabel(grade) {
  return { hit: '吻合', partial: '部分吻合', miss: '不符', pending: '待对照' }[grade] || '待对照';
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadOracleFile(date) {
  const day = date || todayStamp();
  return (await readJson(join(OBSIDIAN_ORACLE, `${day}.json`)))
    || (await readJson(join(OBSIDIAN_ORACLE, `${day}-spx.json`)));
}

export async function listOracleDates() {
  try {
    const names = await readdir(OBSIDIAN_ORACLE);
    return [...new Set([
      ...Object.keys(BUILTIN),
      ...names.filter((name) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(name)).map((name) => name.slice(0, 10))
    ])].sort().reverse();
  } catch {
    return Object.keys(BUILTIN).sort().reverse();
  }
}

export function spxReadingFromCurrent(chart, date) {
  const yong = (chart?.palaces || []).find((row) => row.yong) || null;
  const palace = yong ? `${yong.bagua}${yong.num}宫` : '未标记用神宫';
  const shiGan = chart?.raw?.['時干'] || null;
  return {
    type: 'qimen-spx-reading',
    date,
    liveTrading: false,
    draft: true,
    source: 'qimen-current',
    generated: true,
    recordedAt: chart?.effectiveAt ? new Date(chart.effectiveAt).toISOString() : null,
    title: `SPX 奇门 · 时干${shiGan || '—'}落${palace}`,
    instrument: { symbol: 'SPY', proxyFor: 'SPX', note: 'Yahoo/Nasdaq SPY 5 分钟 K，不是 SPX 期货。盘面由 qimen-current 按北京时间整点生成。' },
    chart: {
      shiGan,
      yongShen: 'SPX',
      palace,
      palaceId: yong?.id || null,
      men: yong?.men || null,
      palaces: chart?.palaces || [],
      qimenDate: chart?.date || null,
      effectiveAt: chart?.effectiveAt || null,
      key: chart?.key || null,
      method: 'qimen-current'
    },
    bias: '自动时盘对照',
    rules: ['高处不追', '低处不慌', '顺势而行'],
    analysis: [
      '本盘由 qimen-current 在写入时自动生成，用来补上当天还没有手工盘的空档。',
      '不套用 2026-09-16 的「先抑后扬」路径，也不把时盘当成下单信号。'
    ],
    rhythm: [],
    risks: ['自动盘只提供宫位，路径评分保持待对照。'],
    watchWindows: [],
    phases: [],
    schematic: []
  };
}

export async function buildOracleDesk({ date, now = Date.now(), loader = loadChart, refresh = false, reading: injected } = {}) {
  const day = date || todayStamp(new Date(now));
  if (!validOracleDay(day)) throw new Error('观察日无效');
  const saved = injected ? null : await loadOracleFile(day);
  const reading = injected || saved || BUILTIN[day] || null;
  if (reading && reading.date !== day) throw new Error('原始盘面日期与文件日期不一致，拒绝套用');
  if (!reading) {
    return {
      ok: true,
      empty: true,
      liveTrading: false,
      date: day,
      dates: await listOracleDates(),
      note: `还没有 ${day} 的奇门盘面。保存今天的对照会用 qimen-current 自动起盘并写入；更早的日期不回填。${ORACLE_NOTE}`
    };
  }
  const symbol = reading.instrument?.symbol || 'SPY';
  let chart;
  try { chart = await loader(symbol, { range: '1mo', interval: '5m', refresh }); }
  catch (error) { chart = { ok: false, error: error.message }; }
  // Nasdaq's chart points are sampled prices aggregated locally, not exchange OHLC bars.
  if (chart?.source === 'nasdaq') chart = { ...chart, ok: false, error: '备用源仅有采样价格，不能作为完整 OHLC 核算路径吻合。' };
  const pack = judgeReading(reading, {
    bars: chart?.ok ? chart.bars : [],
    now,
    source: chart?.source || null,
    last: chart?.last ?? null,
    quoteAt: chart?.quoteAt ?? null
  });
  if (chart && chart.ok === false) pack.session.error = chart.error;
  pack.ok = true;
  pack.cached = Boolean(saved);
  pack.dates = await listOracleDates();
  return pack;
}

export async function ensureOracleWrite({ date, now = Date.now(), loader, refresh = false } = {}) {
  const day = date || todayStamp(new Date(now));
  let pack = await buildOracleDesk({ date: day, now, loader, refresh });
  if (pack.empty) {
    if (day !== todayStamp(new Date(now))) {
      return {
        ...pack,
        error: `${day} 没有已录入盘面。只有当天会用 qimen-current 自动起盘，不回填历史。`
      };
    }
    const reading = spxReadingFromCurrent(currentQimenChart(now), day);
    pack = await buildOracleDesk({ date: day, now, loader, refresh, reading });
    pack.generatedChart = true;
    pack.chartSource = 'qimen-current';
    pack.note = `${pack.note || ''} 当天没有手工盘，已用 qimen-current 自动生成并写入。`.trim();
  }
  if (pack.empty) return pack;
  pack.written = await writeOracle(pack);
  return pack;
}

export async function writeOracle(pack) {
  await mkdir(OBSIDIAN_ORACLE, { recursive: true });
  const day = pack.date;
  const slim = {
    ...pack,
    liveTrading: false,
    draft: true,
    path: (pack.path || []).map((row) => ({ ts: row.ts, close: row.close }))
  };
  const stem = `${day}-spx`;
  await writeFile(join(OBSIDIAN_ORACLE, `${stem}.json`), `${JSON.stringify(slim, null, 2)}\n`, 'utf8');
  await writeFile(join(OBSIDIAN_ORACLE, `${stem}.md`), `${renderOracleMarkdown(pack)}\n`, 'utf8');
  return { dir: OBSIDIAN_ORACLE, date: day, file: stem };
}

export function renderOracleMarkdown(pack) {
  const phaseRows = (pack.phases || []).map((row) => (
    `| ${row.label} | ${row.start}–${row.end} ET | ${gradeLabel(row.grade)} | ${row.reason} |`
  )).join('\n');
  return `---
title: SPX 奇门对照
date: ${pack.date}
type: qimen-spx-reading
liveTrading: false
draft: true
---

# ${pack.date} SPX 奇门对照

> ${pack.note}

- 用神：${pack.chart?.yongShen || 'SPX'} · 时干 ${pack.chart?.shiGan || '—'} · ${pack.chart?.palace || ''}
- 倾向：${pack.bias}
- 对照：${pack.instrument?.symbol || 'SPY'} · ${pack.session?.source || '无行情'}
- 总判：${pack.overall?.headline || ''}

## 五段路径

| 时段 | 纽约时间 | 对照 | 说明 |
| --- | --- | --- | --- |
${phaseRows || '| — |  | 待对照 | 还没有分段 |'}

- 先抑后扬：${gradeLabel(pack.overall?.first?.grade)} · ${pack.overall?.first?.reason || ''}
- 震荡偏多：${gradeLabel(pack.overall?.bias?.grade)} · ${pack.overall?.bias?.reason || ''}
${pack.overall?.dump?.reason ? `- 偏空风险：${pack.overall.dump.reason}` : ''}

不是下单指令。
`;
}
