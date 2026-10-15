import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManyHistoricals } from '../historicals.js';
import { REPORTS_DIR, todayStamp } from '../paths.js';
import { loadUniverse } from '../universe.js';
import {
  adrStopSoftCheck,
  assessStructure,
  marketRegimeHint,
  usableBars
} from './entry.js';
import {
  evaluateLeader,
  evaluatePotent,
  evaluatePremarket,
  passingScanLabel
} from './filters.js';
import {
  ADVICE_FLAGS,
  MAJOR_LIQUID_US,
  MODULE_DOC,
  PLAYBOOK_DOC,
  POST_FILL_STOP_ITEM,
  SCAN_CAP,
  SOURCE_DOC
} from './params.js';

const ACTION_RANK = { BUY_REF: 0, WATCH: 1, HOLD_REF: 2, NO_TRADE: 3 };

function fmt(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

export function resolveNow(input = {}) {
  if (input.now instanceof Date) return input.now;
  if (input.now) return new Date(input.now);
  if (input.asOf) return new Date(`${String(input.asOf).slice(0, 10)}T21:00:00.000Z`);
  return new Date();
}

export function resolveAsOf(input = {}, now = resolveNow(input)) {
  if (input.asOf) return String(input.asOf).slice(0, 10);
  return todayStamp(now);
}

export function mergeScanUniverse(watchlist = [], extra = [], cap = SCAN_CAP) {
  const out = [];
  const seen = new Set();
  for (const symbol of [...watchlist, ...MAJOR_LIQUID_US, ...extra]) {
    const key = String(symbol || '').trim().toUpperCase();
    if (!key || key === 'SPY' || key === 'QQQ' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

function heldSymbols(input = {}) {
  const held = new Set();
  for (const row of input.positions || []) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const qty = Number(row.qty ?? row.quantity ?? row.shares);
    if (symbol && qty > 0) held.add(symbol);
  }
  return held;
}

function rNotes({ entry, plannedStop, soft, action }) {
  if (!(entry > 0)) return '没有可用收盘价，不能计算 R。';
  if (!(plannedStop > 0) || !(entry > plannedStop)) {
    return '还没有结构失效位 planned_stop，不能计算 R。禁止用事后价格倒推【M1】【A】。';
  }
  const risk = entry - plannedStop;
  const pct = (risk / entry) * 100;
  const half = soft.halfAdrPct == null ? 'ADR 不足，½ADR 软检查留空。' : `½ADR 约 ${soft.halfAdrPct.toFixed(2)}%，软检查${soft.pass ? '通过' : '未通过'}。`;
  const tail = action === 'BUY_REF'
    ? '若人工成交，同一轮立刻挂保护止损。本报告不代挂。'
    : '这不是开仓指令。';
  return `参考入场 ${fmt(entry)}（已完成日K收盘，不是委托）。planned_stop ${fmt(plannedStop)} 为结构失效位。每股计划风险 ${fmt(risk)}（${pct.toFixed(2)}%）。${half}R 只许用这个交易前止损计算。没有成交，就还没有实现 R。禁止事后倒推【M1】。${tail}`;
}

function scanReasons(scans) {
  const reasons = [];
  for (const name of ['potent', 'premarket', 'leader']) {
    const scan = scans[name];
    if (!scan) continue;
    if (scan.pass && scan.degraded) reasons.push(`${name} 技术条件通过，但有字段缺失或用了近似口径，待回测【A】。`);
    else if (scan.pass && scan.strictPass) reasons.push(`${name} 公开门槛字段都在，且通过【M2】。`);
    else if (scan.pass) reasons.push(`${name} 通过【M2】。`);
    else if (scan.failed) reasons.push(`${name} 有已给出的字段未过门槛【M2】。`);
    const volatility = scan.checks?.find((check) => check.id === 'volatility_1w');
    if (volatility?.missing) reasons.push('平台 Volatility 1W 缺失，不用 ADR 或一周涨幅填【M2】。');
    const cap = scan.checks?.find((check) => check.id === 'market_cap');
    if (cap?.missing) reasons.push('市值缺失，不臆造【A】。');
    if (scan.checks?.some((check) => check.proxy)) reasons.push('Vol×Price 1W 用近 5 日成交额合计近似，不是原平台字段，待回测【A】。');
  }
  if (scans.premarket?.premarketChangeMissing) reasons.push('盘前涨幅缺失，不编造百分比，排序时放在有数据的名字后面。');
  return [...new Set(reasons)];
}

export function buildCandidate(row = {}, context = {}) {
  const symbol = String(row.symbol || '').trim().toUpperCase();
  const bars = usableBars(row.bars, context.now);
  const potent = evaluatePotent({ ...row, bars });
  const premarket = evaluatePremarket({ ...row, bars });
  const leader = evaluateLeader({ ...row, bars });
  const scans = { potent, premarket, leader };
  const structure = assessStructure(bars);
  const soft = adrStopSoftCheck({
    entry: structure.referenceEntry,
    plannedStop: structure.planned_stop,
    adrPct: structure.adr20Pct
  });
  const held = context.held?.has(symbol) || row.held === true;
  const scan = passingScanLabel(scans);
  const scanPass = Boolean(scan);
  const stageOk = structure.stage === 'LEAD' || structure.stage === 'MEDIOCRE';
  const regimeHint = context.regime?.hint || 'UNKNOWN';
  const regimeOk = regimeHint !== 'RISK_OFF' && regimeHint !== 'UNKNOWN';
  const stopOk = Number.isFinite(structure.planned_stop) && structure.planned_stop < structure.referenceEntry;
  const adrOk = soft.pass === true;
  const pullback = structure.setup === 'FIRST_PULLBACK';
  const reasons = [
    ...scanReasons(scans),
    structure.stageReason,
    structure.note
  ];
  if (row.majorLiquid || (context.majors || MAJOR_LIQUID_US).includes(symbol)) {
    reasons.push('在主要流动性美股名单里；名单只用来补观察池，不代替扫描【A】。');
  }
  if (!stopOk) reasons.push('没有可用的 planned_stop，不能给出买入参考。');
  if (soft.pass === false) reasons.push(soft.note);
  if (soft.pass == null && pullback) reasons.push('ADR 软检查留空，不给买入参考。');
  if (structure.stage === 'LAG') reasons.push('Lag 只是强度分类，不是卖出按钮；这里也不把它当成买入参考【M1】。');
  if (regimeHint === 'RISK_OFF') reasons.push('市场状态 RISK_OFF，不主动给新多参考【A】。');
  if (regimeHint === 'UNKNOWN') reasons.push('市场状态不明，不给新的买入参考【A】。');
  if (held && pullback) reasons.push('已有持仓。回踩只作记录，不在本报告里给加仓 BUY_REF。加仓仍过现有闸门。');
  reasons.push('本行是建议，不替换小鱼点位、评分、Critic、事件闸或 Risk Gateway。');

  let action = 'NO_TRADE';
  if (!held && scanPass && pullback && stageOk && stopOk && adrOk && regimeOk) action = 'BUY_REF';
  else if (held) action = 'HOLD_REF';
  else if (scanPass || structure.setup === 'FIRST_PULLBACK' || structure.setup === 'BREAKOUT_EXTENDED') action = 'WATCH';

  const noMarket = !bars.length && !(row.close > 0);
  if (noMarket) {
    reasons.unshift('行情缺失，已降级跳过，不编造价格。');
  }

  return {
    symbol,
    scan,
    stage: structure.stage,
    planned_stop: structure.planned_stop,
    r_notes: noMarket
      ? '没有行情，不能计算 R，也不编造止损。'
      : rNotes({
        entry: structure.referenceEntry,
        plannedStop: structure.planned_stop,
        soft,
        action
      }),
    action,
    reasons: [...new Set(reasons.filter(Boolean))],
    stopMustPlaceAfterFill: action === 'BUY_REF',
    brokerOrderId: null,
    premarketChangePct: premarket.premarketChangePct,
    performance1mPct: leader.performance1mPct,
    held,
    onWatchlist: Boolean(row.onWatchlist),
    majorLiquid: Boolean(row.majorLiquid || (context.majors || MAJOR_LIQUID_US).includes(symbol)),
    entryChecklist: {
      planned_stop: structure.planned_stop,
      adrSoftCheck: soft,
      stage: structure.stage,
      setup: structure.setup,
      preferFirstHealthyPullback: true,
      replacesExistingGates: false
    },
    levels: {
      close: structure.last,
      ema9: structure.ema9,
      ema21: structure.ema21,
      ema23: structure.ema23,
      ema50: structure.ema50
    },
    scans
  };
}

export function stopChecklistFor(candidates) {
  return (candidates || []).filter((row) => row.action === 'BUY_REF').map((row) => ({
    symbol: row.symbol,
    action: 'BUY_REF',
    stopMustPlaceAfterFill: true,
    item: POST_FILL_STOP_ITEM,
    planned_stop: row.planned_stop,
    brokerOrderId: null,
    note: '成交成功之后才挂 GTC stop。本清单不向券商发单，也不编造订单号。'
  }));
}

function disclaimers(report) {
  const lines = [
    '给 Kawaii美股阅读的参考，不是下单指令。liveTrading 固定为 false。',
    'OwnerBot 是 Kawaii小胡。Self-Directed 7811 只观察、只纸上，本报告不操作 7811。',
    '扫描门槛来自 Martin 2025-02-02 公开回复【M2】。字段归一化、市场状态和回踩判定是工程方案【A】，标为待回测。',
    'Lead / Mediocre / Lag 是 9/21/50 EMA 强度分类，不是买卖按钮【M1】。',
    '偏好突破后的第一次健康回踩。止损距离最好不要超过约 ½ ADR；做不到就放弃，不放宽止损【M1】【A】。',
    '建议新开若人工成交，同一轮立刻挂 GTC stop。本模块不向券商报单，不编造订单号。',
    '正股建议不替换现有闸门。期权不在本报告范围，不读取、不改写短期期权规则。',
    '不把约 10% 分批或 3×ADR 写成硬止盈，也不把第三方 3–5R 卖 1/3 写成规则【M2】。',
    '不默认开通个股做空。'
  ];
  if (!report.candidates.some((row) => row.action === 'BUY_REF')) {
    lines.push('今天没有建议新开，成交后止损清单为空。');
  }
  return lines;
}

function sortCandidates(rows) {
  return [...rows].sort((a, b) => {
    const byAction = (ACTION_RANK[a.action] ?? 9) - (ACTION_RANK[b.action] ?? 9);
    if (byAction) return byAction;
    const change = compareDescNullsLast(a.premarketChangePct, b.premarketChangePct);
    if (change) return change;
    const perf = compareDescNullsLast(a.performance1mPct, b.performance1mPct);
    if (perf) return perf;
    return a.symbol.localeCompare(b.symbol);
  });
}

function compareDescNullsLast(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a === b) return 0;
  return b - a;
}

export function buildMartinAdvice(input = {}) {
  const now = resolveNow(input);
  const asOf = resolveAsOf(input, now);
  const held = heldSymbols(input);
  const regime = input.regime?.hint
    ? { source: 'A', label: '待回测', pendingBacktest: true, notes: [], ...input.regime }
    : marketRegimeHint(
      usableBars(input.spyBars, now),
      usableBars(input.qqqBars, now)
    );
  const seen = new Set();
  const candidates = [];
  for (const row of input.rows || input.symbols || []) {
    const source = typeof row === 'string' ? { symbol: row } : { ...row };
    const symbol = String(source.symbol || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    if (symbol === 'SPY' || symbol === 'QQQ') continue;
    candidates.push(buildCandidate(source, { now, held, regime, majors: input.majors || MAJOR_LIQUID_US }));
  }
  const sorted = sortCandidates(candidates);
  const report = {
    ...ADVICE_FLAGS,
    asOf,
    generatedAt: now.toISOString(),
    regime,
    universe: {
      preferred: 'watchlist+major-liquid-us',
      scanned: sorted.length,
      watchlist: sorted.filter((row) => row.onWatchlist).length,
      majors: sorted.filter((row) => row.majorLiquid).length
    },
    candidates: sorted,
    stopChecklist: [],
    disclaimers: [],
    sources: {
      research: SOURCE_DOC,
      playbook: PLAYBOOK_DOC,
      moduleDoc: MODULE_DOC
    },
    brokerOrderId: null
  };
  report.stopChecklist = stopChecklistFor(sorted);
  report.disclaimers = disclaimers(report);
  return report;
}

export function renderMartinAdviceMarkdown(report) {
  const lines = [
    `# Martin Luk 启发建议 · ${report.asOf}`,
    '',
    `给 ${report.audience} 阅读。OwnerBot：${report.ownerBot}。参考，不是下单。liveTrading=false。7811 只观察/纸上。`,
    '',
    `市场状态提示：${report.regime?.hint || 'UNKNOWN'}（待回测，【A】）`,
    '',
    '## 成交后止损清单',
    ''
  ];
  if (!report.stopChecklist.length) {
    lines.push('今天没有建议新开。清单为空。');
  } else {
    for (const row of report.stopChecklist) {
      lines.push(`- ${row.symbol}：${row.item} @ ${fmt(row.planned_stop)}。stopMustPlaceAfterFill=true。无券商订单号。`);
    }
  }
  lines.push('', '## 候选', '');
  if (!report.candidates.length) lines.push('没有可写的候选。');
  for (const row of report.candidates) {
    lines.push(`- ${row.symbol} · ${row.scan || '无扫描'} · ${row.stage} · ${row.action} · planned_stop ${fmt(row.planned_stop)}`);
    for (const reason of row.reasons.slice(0, 4)) lines.push(`  - ${reason}`);
  }
  lines.push('', '## 声明', '');
  for (const line of report.disclaimers) lines.push(`- ${line}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function writeMartinAdvice(report, { reportsDir = REPORTS_DIR } = {}) {
  await mkdir(reportsDir, { recursive: true });
  const stem = `${report.asOf}-martin-luk-advice`;
  const jsonPath = join(reportsDir, `${stem}.json`);
  const mdPath = join(reportsDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMartinAdviceMarkdown(report), 'utf8');
  return { jsonPath, mdPath, report };
}

export async function buildAndWriteMartinAdvice(input = {}) {
  const report = buildMartinAdvice(input);
  if (input.write === false) return { ok: true, wrote: false, liveTrading: false, jsonPath: null, mdPath: null, report };
  const files = await writeMartinAdvice(report, { reportsDir: input.reportsDir || REPORTS_DIR });
  return { ok: true, wrote: true, liveTrading: false, ...files };
}

export async function adviceFromMarket(options = {}) {
  const explicit = (options.symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
  let symbols = explicit;
  let watch = [];
  if (!symbols.length) {
    const universe = await loadUniverse();
    watch = (universe.symbols || []).map((row) => row.symbol);
    symbols = mergeScanUniverse(watch, options.extraSymbols || []);
  }
  const watchSet = new Set(watch);
  const loaded = await loadManyHistoricals([...symbols, 'SPY', 'QQQ']);
  const rows = symbols.map((symbol) => {
    const pack = loaded[symbol] || { ok: false, bars: [] };
    return {
      symbol,
      bars: pack.bars || [],
      marketOk: pack.ok !== false,
      onWatchlist: watchSet.has(symbol),
      majorLiquid: MAJOR_LIQUID_US.includes(symbol)
    };
  });
  return buildAndWriteMartinAdvice({
    asOf: options.asOf,
    now: options.now,
    rows,
    positions: options.positions || [],
    spyBars: loaded.SPY?.bars || [],
    qqqBars: loaded.QQQ?.bars || [],
    write: options.write,
    reportsDir: options.reportsDir
  });
}
