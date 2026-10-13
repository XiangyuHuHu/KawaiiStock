import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asOfStamp, OBSIDIAN_BRIEF, OBSIDIAN_WATCH, REPORTS_DIR, recsDir, todayStamp } from './paths.js';
import { loadOptionsFile } from './options/engine.js';
import { holdingsAge, loadAccounts, loadHoldings } from './holdings.js';
import { castSymbol } from './oracle/symbols.js';
import { currentQimenChart, qimenSymbol } from './oracle/qimen-current.js';

export const BRIEF_NOTE = 'Agentic 操作意见。综合每日观察、算卦、期权和当日推荐，不是下单指令。不写进推荐操作 / 模拟操作 / 实际操作。默认不下单。缺文件不让每日任务失败。';
const SETUP = new Set(['wedge-pop', 'ema-crossback', 'base-n-break']);
const STAGE_LABEL = {
  'reversal-extension': 'Reversal Extension',
  'wedge-pop': 'Wedge Pop',
  'ema-crossback': 'EMA Crossback',
  'base-n-break': "Base 'n Break",
  'exhaustion-extension': 'Exhaustion Extension',
  'wedge-drop': 'Wedge Drop'
};
const EXIT_STAGES = new Set(['wedge-drop']);
const TRIM_STAGES = new Set(['exhaustion-extension']);
const CALLS = new Set(['BUY_CALL', 'CALL_SPREAD']);
const PUTS = new Set(['BUY_PUT', 'PUT_SPREAD']);
const OPEN_REC = new Set(['BUY', 'ADD']);
const CLOSE_REC = new Set(['EXIT', 'SELL']);

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function leanLabel(lean) {
  return {
    up: '偏涨',
    down: '偏跌',
    trim: '减仓',
    hold: '持有',
    wait: '观望',
    split: '分歧',
    none: '无'
  }[lean] || '无';
}

function indexWatch(watch) {
  const map = new Map();
  const add = (row) => {
    const symbol = upper(row?.symbol);
    if (!symbol) return;
    const prev = map.get(symbol);
    if (!prev) {
      map.set(symbol, row);
      return;
    }
    const betterScore = (row.score ?? -1) > (prev.score ?? -1);
    const betterConfirm = Boolean(row.allowNewLong) && !prev.allowNewLong;
    if (betterConfirm || betterScore) map.set(symbol, { ...prev, ...row });
  };
  for (const list of Object.values(watch?.boards || {})) (list || []).forEach(add);
  for (const list of Object.values(watch?.featured || {})) (list || []).forEach(add);
  for (const row of watch?.universeSnapshot?.rows || []) add(row);
  return map;
}

function watchLean(row) {
  if (!row) return 'none';
  if (EXIT_STAGES.has(row.stage)) return 'down';
  if (TRIM_STAGES.has(row.stage)) return 'trim';
  if (row.stage === 'reversal-extension') return 'wait';
  const confirmed = row.allowNewLong === true && (row.confirmation?.confirmed !== false);
  if (SETUP.has(row.stage) && Number(row.score) >= 80 && confirmed && row.regime !== 'risk-off') return 'up';
  if (SETUP.has(row.stage)) return 'wait';
  return 'none';
}

function optionLean(row) {
  if (!row) return { lean: 'none', eligible: false, action: null };
  const action = row.eligible ? row.action : (row.originalAction || row.action);
  if (CALLS.has(action)) return { lean: 'up', eligible: Boolean(row.eligible), action };
  if (PUTS.has(action)) return { lean: 'down', eligible: Boolean(row.eligible), action };
  if (action === 'STRADDLE') return { lean: 'wait', eligible: Boolean(row.eligible), action };
  return { lean: 'none', eligible: false, action: action || 'NO_TRADE' };
}

function recLean(row) {
  if (!row) return 'none';
  const action = String(row.action || '').toUpperCase();
  if (OPEN_REC.has(action)) return 'up';
  if (CLOSE_REC.has(action)) return 'down';
  if (action === 'TRIM') return 'trim';
  if (action === 'HOLD') return 'hold';
  if (action === 'WATCH' || action === 'WAIT' || action === 'REVIEW') return 'wait';
  return 'none';
}

function oracleLean(row) {
  const dir = row?.direction;
  if (dir === 'up' || dir === 'down') return dir;
  return dir === 'neutral' ? 'wait' : 'none';
}

function combineOracle(mei, qi) {
  const a = oracleLean(mei);
  const b = oracleLean(qi);
  if (a === 'none') return b;
  if (b === 'none') return a;
  if (a === b) return a;
  if (a === 'wait') return b;
  if (b === 'wait') return a;
  return 'split';
}

function agenticBook(recs) {
  return (recs?.accounts || []).find((row) => row.id === 'agentic') || null;
}

function recMap(book) {
  const map = new Map();
  for (const row of [...(book?.recommendations || []), ...(book?.opportunities || []), ...(book?.priorities || [])]) {
    const symbol = upper(row.symbol);
    if (!symbol) continue;
    if (!map.has(symbol)) map.set(symbol, row);
  }
  return map;
}

function optionMap(options) {
  const map = new Map();
  for (const row of [...(options?.ideas || []), ...(options?.buys || [])]) {
    const symbol = upper(row.symbol);
    if (symbol) map.set(symbol, row);
  }
  return map;
}

function chasePct(row) {
  const n = Number(row?.changePct);
  return Number.isFinite(n) ? n : null;
}

export function composeAgenticBrief({
  date,
  watch = null,
  options = null,
  recs = null,
  holdings = null,
  meiBySymbol = {},
  qiBySymbol = {},
  now = new Date()
} = {}) {
  const day = date || todayStamp(now);
  const watchMap = indexWatch(watch);
  const recsBook = agenticBook(recs);
  const recsBySymbol = recMap(recsBook);
  const optionBySymbol = optionMap(options);
  const positions = (holdings?.positions || [])
    .map((row) => ({ ...row, symbol: upper(row.symbol), qty: Number(row.qty) }))
    .filter((row) => row.symbol && row.qty > 0);
  const heldSet = new Set(positions.map((row) => row.symbol));
  const asOf = asOfStamp(holdings?.asOf || holdings?.dataAsOf);
  const holdingAge = holdingsAge(holdings, now);
  const staleHoldings = !asOf || asOf < day;
  const recsMissing = !recs || recs.error || !recsBook;
  const optionsStale = !options?.ok || (options.date && options.date < day) || options.cached;
  const eligibleBuys = (options?.buys || options?.ideas || []).filter((row) => row.eligible);
  const regime = watch?.regime || 'unknown';

  const scanned = (watch?.universeSnapshot?.rows || []).map((row) => upper(row.symbol)).filter(Boolean);
  const focus = new Set([
    ...heldSet,
    ...scanned,
    ...(watch?.boards?.confluence || []).map((row) => upper(row.symbol)),
    ...(watch?.boards?.setups || []).map((row) => upper(row.symbol)),
    ...(watch?.featured?.up || []).map((row) => upper(row.symbol)),
    ...(watch?.featured?.down || []).map((row) => upper(row.symbol)),
    ...recsBySymbol.keys(),
    ...eligibleBuys.map((row) => upper(row.symbol))
  ].filter(Boolean));

  const votes = [...focus].map((symbol) => {
    const watchRow = watchMap.get(symbol) || null;
    const recRow = recsBySymbol.get(symbol) || null;
    const optionRow = optionBySymbol.get(symbol) || null;
    const mei = meiBySymbol[symbol] || null;
    const qi = qiBySymbol[symbol] || null;
    const held = heldSet.has(symbol);
    const option = optionLean(optionRow);
    const oracle = combineOracle(mei, qi);
    const watchDir = watchLean(watchRow);
    const recDir = recLean(recRow);
    const hard = [watchDir, recDir, option.eligible ? option.lean : 'none'].filter((d) => d === 'up' || d === 'down');
    const agreeUp = hard.filter((d) => d === 'up').length;
    const agreeDown = hard.filter((d) => d === 'down').length;
    return {
      symbol,
      held,
      qty: held ? positions.find((row) => row.symbol === symbol)?.qty ?? null : null,
      last: watchRow?.last ?? positions.find((row) => row.symbol === symbol)?.last ?? null,
      watch: watchDir,
      rec: recDir,
      option: option.lean,
      optionEligible: option.eligible,
      optionAction: option.action,
      oracle,
      mei: oracleLean(mei),
      qimen: oracleLean(qi),
      stage: watchRow?.stage || null,
      stageLabel: watchRow?.stageLabel || STAGE_LABEL[watchRow?.stage] || null,
      score: watchRow?.score ?? null,
      allowNewLong: Boolean(watchRow?.allowNewLong),
      confirmed: watchRow?.confirmation?.confirmed === true,
      changePct: chasePct(watchRow),
      stop: watchRow?.stop ?? watchRow?.riskPlan?.stop ?? null,
      agreeUp,
      agreeDown,
      recAction: recRow?.action || null,
      recTitle: recRow?.title || null
    };
  });

  const orders = [];
  for (const row of votes.filter((item) => item.held)) {
    if (staleHoldings) {
      orders.push({
        ...row,
        action: 'REVIEW',
        reason: `${holdingAge.label}。先核对实盘再动；不能按旧仓下达卖出。`
      });
      continue;
    }
    if (row.watch === 'down' || row.rec === 'down') {
      orders.push({
        ...row,
        action: 'EXIT',
        reason: [
          row.watch === 'down' ? `每日观察 ${row.stageLabel || 'Wedge Drop'}，结构失效先止损` : null,
          row.rec === 'down' ? `当日推荐 ${row.recAction}` : null,
          row.oracle === 'down' ? '算卦偏跌只作对照' : null
        ].filter(Boolean).join('；') + '。止损必须及时。'
      });
      continue;
    }
    if (row.watch === 'trim' || row.rec === 'trim') {
      orders.push({
        ...row,
        action: 'TRIM',
        reason: '加速赶顶或推荐减仓。止盈可以慢，先减不是清仓。'
      });
      continue;
    }
    orders.push({
      ...row,
      action: 'HOLD',
      reason: `${row.stageLabel || '无明确破坏'}。现仓先拿着，止盈可以慢；失效价 ${row.stop ?? '看止损页'}。`
    });
  }

  const candidates = votes
    .filter((row) => !row.held)
    .filter((row) => row.watch === 'up' || row.rec === 'up' || (row.optionEligible && row.option === 'up'))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.agreeUp - a.agreeUp);

  const opens = [];
  for (const row of candidates) {
    const blockers = [];
    if (regime === 'risk-off') blockers.push('大盘 Risk Off');
    if (row.watch !== 'up') blockers.push('每日观察不是已确认的 Wedge Pop / EMA Crossback / Base n Break ≥80');
    if (!row.confirmed && row.watch === 'up') blockers.push('观察卡有分数但收盘确认未通过');
    if (recsMissing) blockers.push('当日推荐操作还没落盘，不能当每日任务结论');
    if (!recsMissing && row.rec === 'down') blockers.push('当日推荐要退出或避开');
    if (!recsMissing && row.rec !== 'up' && row.rec !== 'wait' && row.rec !== 'none') blockers.push(`当日推荐是 ${row.recAction || row.rec}`);
    if (!recsMissing && row.rec !== 'up') blockers.push('每日任务没有给这只开新仓');
    if (row.optionEligible && row.option === 'down') blockers.push('期权合格信号是买 Put，与开多冲突');
    if (row.changePct != null && row.changePct >= 15) blockers.push(`今日已涨 ${row.changePct.toFixed(1)}%，禁止追高`);
    if (positions.length + opens.length >= 3) blockers.push('Agentic 已有 1–3 仓上限');
    const buy = blockers.length === 0 && row.watch === 'up' && !recsMissing && row.rec === 'up';
    const blockReason = blockers[0] || null;
    opens.push({
      ...row,
      action: buy ? 'CONSIDER' : 'WATCH',
      blockReason,
      blockers,
      reason: buy
        ? `观察 ${row.stageLabel} ${row.score} 分已确认，推荐 ${row.recAction}。算卦 ${leanLabel(row.oracle)} 只作对照。仍须过闸、带券商止损；未授权不实盘。`
        : `${blockReason}。`
    });
  }

  const consider = opens.filter((row) => row.action === 'CONSIDER').slice(0, 1);
  const watchOnly = opens.filter((row) => row.action === 'WATCH').slice(0, 4);
  const exits = orders.filter((row) => row.action === 'EXIT');
  const trims = orders.filter((row) => row.action === 'TRIM');
  const holds = orders.filter((row) => row.action === 'HOLD');
  const reviews = orders.filter((row) => row.action === 'REVIEW');

  let stance = 'WAIT';
  let headline = 'Agentic：今天可以空着，先别开新仓。';
  if (reviews.length) {
    stance = 'REVIEW';
    headline = 'Agentic：持仓快照不是今天，先核对实盘，不要按旧仓下单。';
  } else if (exits.length) {
    stance = 'REDUCE';
    headline = `Agentic：先处理失效仓 ${exits.map((row) => row.symbol).join('、')}。止损及时，先别加仓。`;
  } else if (consider.length) {
    stance = 'WATCH';
    headline = `Agentic：观察+推荐对齐 ${consider[0].symbol}，仍是意见不是订单。未授权不下单。`;
  } else if (holds.length && !consider.length) {
    stance = 'HOLD';
    headline = `Agentic：现仓 ${holds.map((row) => row.symbol).join('、') || '空'} 先拿着。没有对齐的新开。`;
  }

  const sources = {
    watch: watch?.ok ? {
      date: watch.date,
      generatedAt: watch.generatedAt || null,
      regime: watch.regimeLabel || watch.regime,
      scanned: watch.scanned ?? null,
      voteScope: scanned.length ? 'full-scan' : 'boards',
      voteCount: focus.size,
      demoFallback: watch.demoFallback || null,
      counts: watch.counts || null
    } : { missing: true },
    oracle: { note: '梅花个股卦 + 当前时盘奇门宫位。娱乐对照，不是胜率，不能单独开仓。' },
    options: options?.ok
      ? {
        date: options.date,
        generatedAt: options.generatedAt || null,
        scanned: options.scanned,
        buyCount: options.buys?.length ?? 0,
        cached: Boolean(options.cached),
        stale: Boolean(optionsStale),
        emptyScan: Number(options.scanned) === 0,
        emptyNote: Number(options.scanned) === 0 ? '期权扫描为 0，不把空扫描当成看空。' : null
      }
      : { missing: true },
    recs: recsMissing
      ? { missing: true, date: recs?.date || null, generatedAt: recs?.generatedAt || null }
      : { date: recs.date, generatedAt: recs.generatedAt || null, priorities: (recsBook.priorities || []).map((row) => ({ symbol: row.symbol, action: row.action, title: row.title })) }
  };

  return {
    ok: true,
    type: 'agentic-brief',
    liveTrading: false,
    date: day,
    generatedAt: new Date(now).toISOString(),
    stance,
    headline,
    note: BRIEF_NOTE,
    accountId: 'agentic',
    holdings: {
      asOf: asOf,
      stale: staleHoldings,
      staleAgeDays: holdingAge.ageDays,
      staleLabel: holdingAge.label,
      cash: holdings?.cash ?? null,
      positionCount: positions.length,
      symbols: positions.map((row) => row.symbol)
    },
    sources,
    actions: {
      exit: exits,
      trim: trims,
      hold: holds,
      review: reviews,
      consider,
      watch: watchOnly
    },
    votes,
    rules: [
      '每日观察足迹不是下单；新开要已确认的 Wedge Pop / EMA Crossback / Base n Break。分数 ≥80 只是门槛之一，没通过时只写一条具体原因。',
      '算卦（梅花/奇门）只作对照，不能单独产生买入。',
      '期权只有校验通过的合格候选才算信号；缺买卖盘时间就当没有期权信号。',
      '必须有当日推荐操作，才能把「每日任务结论」算进新开。',
      '禁止追高（当日涨幅 ≥15%）、禁止摊低。止损及时，止盈可以慢。',
      '实盘只许 Agentic，且要过 Risk Gateway、带券商止损。这份文件本身不是订单。'
    ]
  };
}

function mdRow(row) {
  const bits = [
    `**${row.action} ${row.symbol}**`,
    row.stageLabel ? row.stageLabel : null,
    row.score != null ? `${row.score}分` : null,
    `观察 ${leanLabel(row.watch)}`,
    `推荐 ${leanLabel(row.rec)}`,
    `期权 ${leanLabel(row.option)}${row.optionEligible ? '（合格）' : ''}`,
    `算卦 ${leanLabel(row.oracle)}`
  ].filter(Boolean);
  return `- ${bits.join(' · ')}\n  ${row.reason}`;
}

export function renderAgenticBriefMarkdown(pack) {
  const a = pack.actions || {};
  const blocks = [
    ['先处理', a.exit],
    ['减仓', a.trim],
    ['现仓', a.hold],
    ['先核对持仓', a.review],
    ['可研究新开（不是订单）', a.consider],
    ['观察池对齐但今天不开', a.watch]
  ];
  return `---
title: Agentic 操作意见
date: ${pack.date}
liveTrading: false
type: agentic-brief
stance: ${pack.stance}
---

# ${pack.date} Agentic 操作意见

> ${pack.note}

**${pack.headline}**

- 持仓快照 ${pack.holdings?.asOf || '未知'}${pack.holdings?.stale ? '（不是今天，先核对）' : ''} · ${pack.holdings?.positionCount ?? 0} 个标的
- 每日观察 ${pack.sources?.watch?.missing ? '缺失' : pack.sources.watch.date + ' · ' + (pack.sources.watch.regime || '')}
- 推荐操作 ${pack.sources?.recs?.missing ? '当日未落盘' : pack.sources.recs.date}
- 期权 ${pack.sources?.options?.missing ? '缺失' : `${pack.sources.options.date} · 合格买入 ${pack.sources.options.buyCount}`}

${blocks.map(([title, rows]) => `## ${title}\n\n${rows?.length ? rows.map(mdRow).join('\n') : '- 无'}`).join('\n\n')}

## 规则

${(pack.rules || []).map((line) => `- ${line}`).join('\n')}
`;
}

export async function writeAgenticBrief(pack) {
  await mkdir(OBSIDIAN_BRIEF, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
  const json = `${JSON.stringify(pack, null, 2)}\n`;
  const md = `${renderAgenticBriefMarkdown(pack)}\n`;
  await writeFile(join(OBSIDIAN_BRIEF, `${pack.date}.json`), json, 'utf8');
  await writeFile(join(OBSIDIAN_BRIEF, `${pack.date}.md`), md, 'utf8');
  await writeFile(join(REPORTS_DIR, `${pack.date}-Agentic意见.json`), json, 'utf8');
  await writeFile(join(REPORTS_DIR, `${pack.date}-Agentic意见.md`), md, 'utf8');
  return { dir: OBSIDIAN_BRIEF, date: pack.date, file: pack.date };
}

function collectSymbols({ watch, options, recs, holdings }) {
  const symbols = new Set();
  for (const row of holdings?.positions || []) symbols.add(upper(row.symbol));
  for (const list of Object.values(watch?.boards || {})) for (const row of list || []) symbols.add(upper(row.symbol));
  for (const list of Object.values(watch?.featured || {})) for (const row of list || []) symbols.add(upper(row.symbol));
  for (const row of recs?.accounts?.find((item) => item.id === 'agentic')?.recommendations || []) symbols.add(upper(row.symbol));
  for (const row of recs?.accounts?.find((item) => item.id === 'agentic')?.opportunities || []) symbols.add(upper(row.symbol));
  for (const row of options?.ideas || []) symbols.add(upper(row.symbol));
  symbols.delete('');
  return [...symbols];
}

function newerThan(upstreamAt, briefAt) {
  const upstream = Date.parse(upstreamAt || '');
  const brief = Date.parse(briefAt || '');
  return Number.isFinite(upstream) && (!Number.isFinite(brief) || upstream > brief + 1000);
}

export function briefUpstreamStatus(brief, upstream = {}) {
  const notes = [];
  if (newerThan(upstream.watch?.generatedAt, brief?.generatedAt)) notes.push('每日观察生成时间新于这份意见');
  if (newerThan(upstream.options?.generatedAt, brief?.generatedAt)) notes.push('期权扫描生成时间新于这份意见');
  if (newerThan(upstream.recs?.generatedAt, brief?.generatedAt)) notes.push('推荐操作生成时间新于这份意见');
  if (upstream.watch?.scanned != null && brief?.sources?.watch?.scanned != null && upstream.watch.scanned !== brief.sources.watch.scanned) {
    notes.push(`观察去重扫描 ${upstream.watch.scanned}，意见里记的是 ${brief.sources.watch.scanned}`);
  }
  if (Number(upstream.options?.scanned) === 0) notes.push('期权扫描为 0，不把空扫描当成看空');
  const upstreamStale = notes.some((line) => !line.startsWith('期权扫描为 0'));
  return { upstreamStale, upstreamNotes: notes };
}

export async function loadAgenticBrief(date) {
  const day = date || todayStamp();
  const exact = await readJson(join(OBSIDIAN_BRIEF, `${day}.json`));
  if (exact) return exact;
  if (date) return null;
  try {
    const names = (await readdir(OBSIDIAN_BRIEF)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    for (const name of names) {
      const pack = await readJson(join(OBSIDIAN_BRIEF, name));
      if (pack) return { ...pack, stale: true, requestedDate: day };
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadAgenticBriefWithFreshness(date) {
  const brief = await loadAgenticBrief(date);
  if (!brief?.date) return brief;
  const watch = await readJson(join(OBSIDIAN_WATCH, `${brief.date}.json`));
  const options = await loadOptionsFile(brief.date);
  const recs = await readJson(join(recsDir('grok'), `${brief.date}.json`));
  return { ...brief, ...briefUpstreamStatus(brief, { watch, options, recs }) };
}

export async function buildAndWriteAgenticBrief({
  date,
  watchlist,
  options,
  recs,
  holdings,
  now = new Date()
} = {}) {
  const day = date || todayStamp(now);
  const watch = watchlist || await readJson(join(OBSIDIAN_WATCH, `${day}.json`));
  const optionPack = options || await loadOptionsFile(day) || await loadOptionsFile();
  const recPack = recs === undefined ? await readJson(join(recsDir('grok'), `${day}.json`)) : recs;
  let book = holdings;
  if (!book) {
    const config = await loadAccounts('grok');
    const account = (config.accounts || []).find((row) => row.id === 'agentic');
    book = account ? await loadHoldings(account) : { positions: [] };
    const fileAsOf = asOfStamp(book.asOf || book.dataAsOf);
    if (fileAsOf && fileAsOf < day) {
      const existing = await readJson(join(OBSIDIAN_BRIEF, `${day}.json`));
      if (existing?.holdings?.asOf === day && existing.holdings.stale === false) {
        book = {
          asOf: existing.holdings.asOf,
          cash: existing.holdings.cash,
          positions: (existing.votes || []).filter((row) => row.held).map((row) => ({
            symbol: row.symbol,
            qty: row.qty,
            last: row.last
          }))
        };
      }
    }
  }
  const symbols = collectSymbols({ watch, options: optionPack, recs: recPack, holdings: book });
  const meiBySymbol = {};
  const qiBySymbol = {};
  const chart = currentQimenChart(Number(now));
  for (const symbol of symbols) {
    try { meiBySymbol[symbol] = castSymbol(symbol, day, 'us'); } catch { meiBySymbol[symbol] = null; }
    qiBySymbol[symbol] = qimenSymbol({ symbol, market: 'us', name: symbol }, chart.palaces);
  }
  const pack = composeAgenticBrief({
    date: day,
    watch,
    options: optionPack,
    recs: recPack,
    holdings: book,
    meiBySymbol,
    qiBySymbol,
    now
  });
  await writeAgenticBrief(pack);
  return pack;
}
