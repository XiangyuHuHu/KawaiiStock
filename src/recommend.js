import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPORTS_DIR, recsDir } from './paths.js';
import { ensureRecsDir, loadAccounts, loadHoldings } from './holdings.js';
import { loadQuotes } from './quotes.js';
import { upcomingEarnings } from './events.js';
import { loadUniverse } from './universe.js';
import {
  attachStrategy,
  isCycleExit,
  isCycleTrim,
  loadCycleBook,
  strategyLabel
} from './strategy/cycle.js';
import { formatWinRate, loadWatchScore, lookupStageRate } from './strategy/watch-score.js';

const UNKNOWN_MAIN = ['FPS', 'INFQ', 'CBRS', 'CCXI', 'VOYG'];
const MIGRATE_MAIN = ['POET', 'SMR', 'INTC'];
const CORE_MAIN = ['MU', 'MRVL', 'PANW', 'ORCL', 'CRWD'];
const WAVE_TACTICAL = ['MRVL', 'VRT', 'ANET', 'APP'];
const LEVERED_2X = new Set(['QLD', 'SSO', 'NVDL', 'USD', 'ROM', 'UYG', 'DIG', 'ERX', 'BOIL', 'AGQ']);
const LEVERED_3X = new Set(['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA', 'SPXL', 'SPXS', 'TECL', 'TECS', 'FAS', 'FAZ', 'LABU', 'LABD']);
const MAIN_QUALITY = new Set([
  'NVDA', 'AMD', 'AMAT', 'QCOM', 'PLTR', 'CRDO', 'WDC', 'STX', 'ON', 'TSLA', 'AVGO', 'TSM', 'ASML', 'MSFT', 'GOOGL', 'AMZN', 'META'
]);
const TOOL_OVERLAY = [
  { symbol: 'QLD', name: 'ProShares Ultra QQQ (2x)', overlay: '2x-etf', lists: ['工具叠加'] },
  { symbol: 'NVDL', name: 'GraniteShares 2x Long NVDA', overlay: '2x-etf', lists: ['工具叠加'] },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductors Bull 3x', overlay: '3x-etf', lists: ['工具叠加'] }
];

function todayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((row) => row.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function heldSet(holdings) {
  return new Set((holdings.positions || []).map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean));
}

function listLabel(row) {
  if (row.overlay) return (row.lists || ['工具叠加']).join(' / ');
  return (row.lists || []).join(' / ') || (row.buckets || []).join(' / ') || '扫描';
}

function instrumentOf(symbol, overlay, name = '') {
  if (overlay) return overlay;
  const sym = String(symbol || '').toUpperCase();
  const label = `${sym} ${name}`;
  if (LEVERED_2X.has(sym) || /2X|二倍/.test(label)) return '2x-etf';
  if (LEVERED_3X.has(sym) || /3X|三倍/.test(label)) return '3x-etf';
  return 'stock';
}

function failPrice(quote, pct) {
  if (!quote?.ok || quote.last == null) return null;
  return Number((quote.last * (1 - pct)).toFixed(2));
}

function moneyPct(navHint, pct) {
  if (navHint && Number.isFinite(navHint)) {
    return `${pct}% NAV（约 $${Math.round(navHint * pct / 100)}）`;
  }
  return `${pct}% NAV`;
}

function navHintOf(account, holdings) {
  const total = Number(holdings.totalValue ?? holdings.equity);
  if (Number.isFinite(total) && total > 0) return total;
  if (account.id === 'tactical') return 20_000;
  if (account.id === 'agentic') return 5_000;
  return holdings.costTotal;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function isNativeChatgptRec(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.type === 'daily-recommendation') return true;
  return Array.isArray(json.orders) && json.orders.length > 0;
}

function workingOrderRec(order) {
  const symbol = String(order.symbol || '').toUpperCase();
  const side = String(order.side || order.type || '').toLowerCase();
  const isBuy = /buy|bid/.test(side);
  const isStop = String(order.type || order.trigger || '').toLowerCase().includes('stop')
    || order.stopPrice != null
    || order.stop_price != null;
  const price = order.price ?? order.limitPrice ?? order.limit_price ?? order.stopPrice ?? order.stop_price ?? null;
  const qty = order.qty ?? order.quantity ?? null;
  const notional = qty != null && price != null && Number.isFinite(Number(qty)) && Number.isFinite(Number(price))
    ? Number(qty) * Number(price)
    : null;
  const kindLabel = isStop ? (isBuy ? '止损买单' : '止损卖单') : (isBuy ? '买单' : '卖单');
  return {
    symbol,
    qty,
    last: price,
    changePct: null,
    kind: 'working-order',
    action: 'WAIT',
    title: `未成交${kindLabel} @ ${price ?? '—'}`,
    detail: `${order.timeInForce || order.tif || 'GTC'} 挂单 ${order.orderId || order.id || ''}。不成交不改价追。模拟仓不把挂单当成持仓。`,
    limitPrice: price,
    failPrice: isBuy ? price : null,
    maxLoss: isBuy && notional != null ? `若全成，最大现金占用约 $${notional.toFixed(2)}` : undefined
  };
}

function actionForMain(row, quote) {
  const tiny = Number(row.qty) <= 10 || (row.cost != null && Number(row.cost) < 3000);
  if (UNKNOWN_MAIN.includes(row.symbol)) {
    return { action: 'REVIEW', title: '身份/职责待核验', detail: '主账户不应长期堆未核验小票。优先清理，现金用于补核心而不是再买。' };
  }
  if (tiny) {
    return { action: 'TRIM', title: '清理碎片仓', detail: '对大账户收益几乎无贡献，优先并入现金或核心仓。不为每天有动作而留下。' };
  }
  if (MIGRATE_MAIN.includes(row.symbol)) {
    return { action: 'HOLD', title: '保留但列入迁出候选', detail: '高Beta / 修复仓更适合战术账户；主账户只在中长期逻辑仍成立时暂留，不再加仓。' };
  }
  if (quote?.ok && quote.changePct <= -8) {
    return {
      action: 'HOLD',
      title: '逻辑复核，不自动卖',
      detail: `当日 ${quote.changePct.toFixed(1)}%。主账户不做机械 10% 止损；先问 2–3 年逻辑有没有坏。`
    };
  }
  const core = CORE_MAIN.includes(row.symbol);
  return {
    action: 'HOLD',
    title: core ? '核心仓维持' : '维持',
    detail: '没有逻辑破坏证据时，主账户默认不交易。'
  };
}

function actionForTactical(row, quote) {
  const inst = instrumentOf(row.symbol, null, row.name);
  if (String(row.symbol || '').includes('ZZZ')) {
    return {
      action: 'REVIEW',
      title: '公司行动/占位核验',
      detail: '无可解析报价的占位证券。核验后处理，不要当成可交易战术仓。'
    };
  }
  if (Number(row.qty) <= 1) {
    return {
      action: 'TRIM',
      title: '清掉1股占位',
      detail: '战术账户要资金效率，观察应放 list，不要占决策带宽。本笔最大亏损：清仓即可，接近已投入金额。',
      instrument: inst
    };
  }
  if (inst === '2x-etf' || inst === '3x-etf') {
    return {
      action: 'HOLD',
      title: inst === '2x-etf' ? '2x 工具仓，不当底仓' : '3x 工具仓，不当底仓',
      detail: '杠杆产品是战术工具。趋势破坏必须退出。止损及时，止盈可以慢。',
      instrument: inst,
      failPrice: failPrice(quote, 0.04),
      failBy: '趋势破坏或 1–5 日',
      maxLoss: '普通 1.5%–3% NAV'
    };
  }
  if (quote?.ok && quote.changePct <= -8) {
    return {
      action: 'SELL',
      title: '检查计划止损',
      detail: `当日 ${quote.changePct.toFixed(1)}%。战术账户止损必须及时；打穿事先最大亏损/结构失效就走，不等回本。`,
      failPrice: failPrice(quote, 0.08),
      failBy: '当日 / 结构破坏',
      maxLoss: '本笔按计划止损，不得改成长期投资'
    };
  }
  if (WAVE_TACTICAL.includes(row.symbol)) {
    return {
      action: 'HOLD',
      title: '波段主仓',
      detail: '可做趋势/回调，不要做成长期底仓。持有期默认 1–20 个交易日。',
      failBy: '1–20 个交易日或结构破坏',
      maxLoss: '普通 1.5%–3% NAV'
    };
  }
  return {
    action: 'HOLD',
    title: '高Beta仓，设好失效位',
    detail: '催化消失或跌破计划止损当日处理。止盈可以慢。',
    failBy: '催化消失或 ≤20 个交易日',
    maxLoss: '高信念 3%–5% NAV'
  };
}

function actionForAgentic(row, quote) {
  const last = quote?.ok ? quote.last : row.last;
  if (quote?.ok && quote.changePct <= -8) {
    return {
      action: 'SELL',
      title: '检查预先写的失效位',
      detail: `当日 ${quote.changePct.toFixed(1)}%。Agentic 可以承担任何风险，但不能无限扛；打穿事先最大亏损就走。`,
      failPrice: failPrice(quote, 0.08),
      failBy: '当日（短持偏好）',
      maxLoss: '以开仓时写明的最大亏损为准，禁止事后改成无限'
    };
  }
  return {
    action: 'HOLD',
    title: '检查时间失效是否仍有效',
    detail: '短持是偏好不是硬禁。超过原计划必须重写理由、失效价和这笔现在还能亏多少。',
    failPrice: last != null ? Number((Number(last) * 0.92).toFixed(2)) : null,
    failBy: '原计划到期；未写则默认 T+5 重写',
    maxLoss: '必须已写在开仓计划里'
  };
}

function pickEngine(accountId) {
  if (accountId === 'main') return actionForMain;
  if (accountId === 'tactical') return actionForTactical;
  return actionForAgentic;
}

function scoreCandidate(row, quote, accountId, cycle) {
  const buckets = row.buckets || [];
  const change = quote?.ok ? Number(quote.changePct) || 0 : 0;
  const inst = instrumentOf(row.symbol, row.overlay);
  let score = 0;
  if (buckets.includes('primary')) score += 3;
  if (buckets.includes('highBeta')) score += 2;
  if (buckets.includes('tactical')) score += 1;
  if (MAIN_QUALITY.has(row.symbol)) score += 2;
  // 小涨确认加分；单日 ±8% 以上是追高或接刀，降权。
  if (change >= -1 && change <= 4) score += 1;
  if (Math.abs(change) >= 8) score -= 2;
  if (accountId === 'main') {
    if (inst !== 'stock') return -99;
    if (buckets.includes('highBeta') && !buckets.includes('primary') && !MAIN_QUALITY.has(row.symbol)) score -= 4;
    if (!buckets.includes('primary') && !MAIN_QUALITY.has(row.symbol)) score -= 2;
  }
  if (accountId === 'tactical') {
    if (inst === '3x-etf') return -99;
    if (inst === '2x-etf') score += 4;
    if (buckets.includes('highBeta')) score += 2;
  }
  if (accountId === 'agentic') {
    if (inst !== 'stock') score += 3;
    if (buckets.includes('highBeta')) score += 2;
    if (!buckets.length && !row.overlay) score += 1;
  }
  if (cycle?.ok && cycle.score != null) {
    score += cycle.score / 10;
    if (cycle.allowNewLong) score += 6;
    else if (cycle.watch) score += 2;
    if (cycle.stage === 'wedge-drop' || cycle.stage === 'exhaustion-extension') score -= 20;
    if (cycle.stage === 'reversal-extension') score -= 4;
  }
  return score;
}

function applyCycleAction(accountId, rec, cycle) {
  const tagged = attachStrategy(rec, cycle);
  if (cycle?.stop && tagged.failPrice == null && ['BUY', 'ADD', 'WATCH'].includes(tagged.action)) {
    tagged.failPrice = cycle.stop;
  }
  if (!cycle?.ok) return tagged;
  if (['REVIEW', 'WAIT'].includes(rec.action)) return tagged;
  if (rec.kind === 'working-order' || rec.instrument === 'option') return tagged;
  const locked = ['SELL', 'EXIT', 'TRIM'].includes(rec.action) && /碎片|占位|1股|身份/.test(`${rec.title || ''}${rec.detail || ''}`);
  if (locked) return tagged;

  if (accountId === 'main') {
    if (isCycleExit({ strategy: cycle }) && rec.action === 'HOLD') {
      return {
        ...tagged,
        action: 'EXIT',
        title: `价格周期：${cycle.stageLabel}`,
        detail: `${cycle.note}。主账户只在趋势结构破坏时退出，不是机械止损。`
      };
    }
    if (isCycleTrim({ strategy: cycle }) && rec.action === 'HOLD') {
      return {
        ...tagged,
        action: 'TRIM',
        title: `价格周期：${cycle.stageLabel}`,
        detail: `${cycle.note}。加速赶顶先减，止盈可以慢，不是清仓信号。`
      };
    }
    return tagged;
  }

  if (isCycleExit({ strategy: cycle }) && ['HOLD', 'WATCH', 'ADD'].includes(rec.action)) {
    if (rec.kind === 'opportunity') {
      return {
        ...tagged,
        action: 'WATCH',
        title: `避开 ${cycle.stageLabel}`,
        detail: `${cycle.note}。禁止新开多。`
      };
    }
    return {
      ...tagged,
      action: 'SELL',
      title: `价格周期：${cycle.stageLabel}，先走`,
      detail: `${cycle.note}。突破失败/趋势破坏立即撤，不要等基本面报告。`,
      failPrice: cycle.stop ?? tagged.failPrice,
      failBy: '结构破坏当日'
    };
  }
  if (isCycleTrim({ strategy: cycle }) && rec.action === 'HOLD') {
    return {
      ...tagged,
      action: 'TRIM',
      title: `价格周期：${cycle.stageLabel}，先减`,
      detail: `${cycle.note}。禁止新开多。止盈分批，剩余仓位继续用失效价管。`
    };
  }
  return tagged;
}

function buildOpportunity(accountId, row, quote, navHint, cycle) {
  const inst = instrumentOf(row.symbol, row.overlay);
  const source = listLabel(row);
  const last = quote?.ok ? quote.last : null;
  const change = quote?.ok ? quote.changePct : null;
  const cycleStop = cycle?.stop ?? null;

  if (accountId === 'main') {
    return applyCycleAction(accountId, {
      symbol: row.symbol,
      action: 'WATCH',
      title: cycle?.ok ? `中长期观察（${cycle.stageLabel} · ${cycle.score}）` : '中长期候选，今日不买',
      detail: cycle?.ok
        ? `${cycle.note}。主账户今天不为周期信号开仓；只用来判断现仓该拿还是减。`
        : '全 list 可扫，但主账户现金极低、现仓约 20 项。先清 D 级、补现金，再讨论是否升级成核心。不为每天有动作而开仓。',
      source,
      instrument: inst,
      failPrice: null,
      failBy: '逻辑破坏 / 6–36 个月复核',
      maxLoss: '主账户不用机械 10% 止损；逻辑破坏才清',
      last,
      changePct: change,
      kind: 'opportunity'
    }, cycle);
  }

  if (accountId === 'tactical') {
    const is2x = inst === '2x-etf';
    return applyCycleAction(accountId, {
      symbol: row.symbol,
      action: 'WATCH',
      title: cycle?.allowNewLong
        ? `战术 Cycle · ${cycle.stageLabel} · ${cycle.score}`
        : (is2x ? '2x 工具候选（须先写最大亏损）' : '战术新机会'),
      detail: cycle?.ok
        ? `${cycle.note}。短中线/事件仓：只做 Wedge Pop / EMA Crossback / Base 'n Break。`
        : (is2x
          ? '二倍产品是战术工具不是底仓。趋势破坏必须退出。默认草稿，不自动下单。'
          : '短中线/事件/高Beta 候选。跌破结构就走，不要迁成主账户式长期持有。'),
      source,
      instrument: inst,
      failPrice: cycleStop ?? failPrice(quote, is2x ? 0.04 : 0.07),
      failBy: is2x ? '趋势破坏或 1–5 日' : '1–20 个交易日或催化消失',
      maxLoss: moneyPct(navHint ?? 20_000, is2x ? 2 : 3),
      last,
      changePct: change,
      kind: 'opportunity'
    }, cycle);
  }

  const offList = !row.lists?.length || source === '扫描' || source === '工具叠加';
  const aggressive = inst !== 'stock' || (quote?.ok && Math.abs(quote.changePct) >= 6);
  const blocker = cycle?.allowNewLong && inst === 'stock' ? entryBlocker(row.symbol, last ?? cycle.last, cycleStop, change) : null;
  const qualify = cycle?.allowNewLong && inst === 'stock' && !blocker;
  return applyCycleAction(accountId, {
    symbol: row.symbol,
    action: qualify ? 'BUY' : 'WATCH',
    title: qualify
      ? `Cycle · ${cycle.stageLabel} · ${cycle.score}`
      : (cycle?.ok ? `观察 ${cycle.stageLabel} · ${cycle.score}` : (aggressive ? '激进实验候选' : 'Agentic 新机会')),
    detail: qualify
      ? `${cycle.note}。0C 只做 02/03/04 且 ≥80 分。实盘默认不下单。禁止追高/摊低。`
      : (cycle?.ok
        ? `${cycle.note}${blocker ? `。今天不买：${blocker}` : ''}。Reversal 只观察；Exhaustion / Wedge Drop 禁止新开多。`
        : (offList
          ? '清单外扫描发现，可以进推荐，但必须写清最大亏损。禁止裸卖和算不清亏多少的结构。默认草稿。'
          : '可任何操作、承担任何风险。短持是偏好不是硬禁。每条都要有失效价和时间。默认 Phase 1 不下单。')),
    source: offList ? `${source || '清单外扫描'}` : source,
    instrument: inst === 'stock' && aggressive ? 'stock+option-ok' : inst,
    failPrice: cycleStop ?? failPrice(quote, inst === 'stock' ? 0.08 : 0.04),
    failBy: inst.includes('etf') || aggressive ? '当日收盘或 T+3（0DTE 则为当日）' : 'T+5 重写理由（偏好，非硬清）',
    maxLoss: inst === 'stock' ? moneyPct(navHint ?? 5_000, 4) : '权利金或杠杆仓位 100% 可亏光，事先写死上限',
    last,
    changePct: change,
    targetPrice: qualify ? cycle.riskPlan?.target ?? null : null,
    kind: 'opportunity'
  }, cycle);
}

let EARNINGS_SOON = new Map();

export function setEarningsSoon(map) {
  EARNINGS_SOON = map instanceof Map ? map : new Map();
}

/** 确认信号次日开仓前的现价检查：已破止损、止损过宽/过窄、当日追高、临近财报都不买。 */
export function entryBlocker(symbol, last, stop, changePct) {
  const px = Number(last), sl = Number(stop);
  const earn = EARNINGS_SOON.get(String(symbol || '').toUpperCase());
  if (earn) return `${earn} 公布财报，跳空风险`;
  if (!(px > 0) || !(sl > 0)) return '缺现价或止损';
  if (px <= sl) return '现价已在止损下方';
  const risk = (px - sl) / px;
  if (risk < 0.015) return '现价离止损不到 1.5%';
  if (risk > 0.10) return '现价离止损超过 10%，追高了';
  if (Number(changePct) >= 6) return `当日已涨 ${Number(changePct).toFixed(1)}%，不追`;
  return null;
}

function pickOpportunities(accountId, universe, quotes, held, navHint, cap, cycles = {}) {
  const extra = accountId === 'main'
    ? []
    : TOOL_OVERLAY.filter((row) => (accountId === 'tactical' ? row.overlay === '2x-etf' : true));
  const pool = [
    ...universe.symbols.map((row) => ({
      symbol: row.symbol,
      lists: row.lists,
      buckets: row.buckets,
      overlay: null
    })),
    ...extra
  ].filter((row) => row.symbol && !held.has(row.symbol));

  const ranked = pool
    .map((row) => ({
      row,
      quote: quotes[row.symbol],
      cycle: cycles[row.symbol],
      score: scoreCandidate(row, quotes[row.symbol], accountId, cycles[row.symbol])
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.symbol).localeCompare(b.row.symbol));

  const limit = cap ?? (accountId === 'tactical' ? 2 : 3);
  const seen = new Set();
  const out = [];
  for (const item of ranked) {
    if (out.length >= limit) break;
    if (accountId === 'main' && !MAIN_QUALITY.has(item.row.symbol) && !(item.row.buckets || []).includes('primary')) continue;
    if (accountId === 'agentic' && item.cycle?.stage === 'wedge-drop') continue;
    if (seen.has(item.row.symbol)) continue;
    seen.add(item.row.symbol);
    out.push(buildOpportunity(accountId, item.row, item.quote, navHint, item.cycle));
  }
  if (accountId === 'tactical' && !out.some((row) => row.instrument === '2x-etf')) {
    const overlay = extra.find((row) => row.overlay === '2x-etf' && !held.has(row.symbol));
    if (overlay) {
      if (out.length >= limit) out.pop();
      out.unshift(buildOpportunity(accountId, overlay, quotes[overlay.symbol], navHint, cycles[overlay.symbol]));
    }
  }
  return out;
}

function withPaperStop(accountId, row) {
  if (row.failPrice != null || row.last == null) return row;
  const pct = accountId === 'main' ? 0.15 : 0.08;
  return { ...row, failPrice: Number((Number(row.last) * (1 - pct)).toFixed(2)) };
}

function fmtPx(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function fmtPct(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(1)}%`;
}

function strategyCell(row) {
  if (row.strategyLabel) return row.strategyLabel;
  if (row.strategy?.id) {
    const wr = row.strategy.winRate;
    return `${strategyLabel(row.strategy)} · ${wr?.n ? `胜率 ${wr.rate}%（${wr.hits}/${wr.n}）` : '胜率待结算'}`;
  }
  return '—';
}

function paintWinRates(payload, score) {
  const paint = (row, book) => {
    if (!row) return row;
    const strategy = row.strategy
      || book?.recommendations?.find((item) => item.symbol && item.symbol === row.symbol)?.strategy
      || book?.opportunities?.find((item) => item.symbol && item.symbol === row.symbol)?.strategy;
    if (!strategy) return row;
    const stats = lookupStageRate(score, strategy.stage);
    const winRate = stats?.n
      ? { rate: stats.rate, hits: stats.hits, n: stats.n, usefulRate: stats.usefulRate }
      : null;
    return {
      ...row,
      strategy: { ...strategy, winRate },
      strategyLabel: `${strategyLabel(strategy)} · ${formatWinRate(winRate)}`
    };
  };
  payload.accounts = (payload.accounts || []).map((book) => ({
    ...book,
    recommendations: (book.recommendations || []).map((row) => paint(row, book)),
    opportunities: (book.opportunities || []).map((row) => paint(row, book)),
    paperCandidates: (book.paperCandidates || []).map((row) => paint(row, book)),
    priorities: (book.priorities || []).map((row) => paint(row, book))
  }));
  payload.watchScore = score?.ok
    ? { byStage: score.locked?.byStage, all: score.locked?.all, rule: score.rule }
    : null;
  return payload;
}

function renderRecMarkdown(date, payload) {
  const cycle = payload.scan?.cycle;
  const cycleLine = cycle
    ? `价格周期：${cycle.name} · 大盘 ${cycle.regimeLabel || cycle.regime} · 扫描 ${cycle.counted} · 可开 ${cycle.tradeable}。只做 Wedge Pop / EMA Crossback / Base 'n Break；≥80 分才买。`
    : '';
  const blocks = payload.accounts.map((book) => {
    const lines = book.recommendations.map((row) => (
      `| ${row.symbol} | ${row.action} | ${row.qty ?? ''} | ${fmtPx(row.last)} | ${row.changePct == null ? '—' : fmtPct(row.changePct)} | ${strategyCell(row)} | ${row.title} | ${row.detail} |`
    )).join('\n');
    const opLines = (book.opportunities || []).map((row) => (
      `| ${row.symbol} | ${row.action} | ${row.source || ''} | ${strategyCell(row)} | ${row.instrument || 'stock'} | ${fmtPx(row.failPrice)} | ${row.failBy || '—'} | ${row.maxLoss || '—'} | ${row.title} | ${row.detail} |`
    )).join('\n');
    const top = book.priorities.map((item, i) => `${i + 1}. **${item.action} ${item.symbol || ''}** — ${item.title}${item.strategyLabel ? `（${item.strategyLabel}）` : ''}`).join('\n') || '今日无必须执行项。';
    return `## ${book.label}

来源：${book.source} · 持仓 ${book.positionCount} · 现金 ${book.cash == null ? '未记录' : '$' + Number(book.cash).toLocaleString('en-US')} · asOf ${book.asOf || '未知'}${book.stale ? ' · **缺数据，不是今日实时**' : ''}

扫描：全部 list（${payload.scan.listSummary}），${payload.scan.symbolCount} 个名字。本账户按职责筛选，不按「能不能看」。
${cycleLine ? `\n${cycleLine}\n` : ''}

### 优先动作

${top}

### 持仓处理

| 代码 | 动作 | 数量 | 现价 | 当日 | 策略 | 结论 | 理由 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
${lines || '| — | WAIT |  |  |  |  | 空仓 | 档案为空则保持空，不编造持仓。新机会见下表。 |'}

### 新机会（全 list 扫描）

| 代码 | 动作 | 来源 | 策略 | 工具 | 失效价 | 时间失效 | 最大亏损 | 结论 | 理由 |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |
${opLines || '| — | WAIT |  |  |  |  |  |  | 无合格新机会 | 没有符合本账户职责的候选，持有现金。 |'}
`;
  }).join('\n');

  const advisor = payload.advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const advisorLabel = advisor === 'chatgpt' ? 'ChatGPT' : 'Grok';
  return `---
title: ${advisorLabel} 推荐操作
date: ${date}
advisor: ${advisor}
liveTrading: false
type: rec-operation
---

# ${date} ${advisorLabel} 推荐操作

> 每日任务写出的建议清单。模拟引擎只解析同名 JSON（\`推荐操作/${date}.json\`），本 Markdown 给人看。没有文件则模拟操作 HOLD，不编造买卖。
> ${advisor === 'chatgpt' ? '本文件按 ChatGPT 三本手册规则写成操作清单；空仓不编造买单。不覆盖手册正文。' : '三账户都扫全部 list。区别在职责和工具，不在视野。每只股票的策略列来自 Cycle of Price Action（成交量 + RS vs QQQ + 大盘 Regime + 失效价）。实盘默认不下单。纸上实验 0A/0B/0C 由每日任务自动过闸，不手操。'}

${blocks}

## 纪律

- 主账户：中长期动作；不为每天有动作而交易。
- 战术账户：止损快，止盈可以慢；每笔先写最大亏损。
- Agentic：可实验，但禁止无限责任。模拟 Day0 两边共用 Grok Agentic 实盘快照；档案仍空才回退到空仓 + $5000。
- 模拟操作成交认 JSON 里的 \`recommendations\`，以及 ChatGPT 原生 \`orders\`。WATCH / WAIT / REVIEW / HOLD 不成交。实际买卖记在「实际操作」，不要和本文件混放。
`;
}

async function buildGrokRecommendations() {
  const config = await loadAccounts();
  const universe = await loadUniverse();
  const books = [];
  for (const account of config.accounts) {
    books.push({ account, holdings: await loadHoldings(account) });
  }

  const heldAll = books.flatMap(({ holdings }) => (holdings.positions || []).map((row) => row.symbol));
  const openAll = books.flatMap(({ holdings }) => (holdings.openOrders || []).map((row) => row.symbol));
  const overlaySymbols = TOOL_OVERLAY.map((row) => row.symbol);
  const universeSample = universe.symbols.map((row) => row.symbol);
  const symbols = [...new Set([
    ...heldAll,
    ...openAll,
    ...(config.focusTape || []),
    ...overlaySymbols,
    ...universeSample,
    ...MAIN_QUALITY
  ].filter(Boolean))];
  const quotes = await loadQuotes(symbols, { concurrency: 8 });
  const lastBySymbol = Object.fromEntries(symbols.map((s) => [s, quotes[s]?.ok ? quotes[s].last : null]));
  const cycleBook = await loadCycleBook(symbols, {
    bySymbol: universe.bySymbol || {},
    lastBySymbol,
    concurrency: 5
  });
  const cycles = cycleBook.bySymbol || {};
  const date = todayStamp();
  setEarningsSoon(await upcomingEarnings(3));

  const accounts = books.map(({ account, holdings }) => {
    const engine = pickEngine(account.id);
    const held = heldSet(holdings);
    const navHint = navHintOf(account, holdings);
    const recommendations = (holdings.positions || []).map((row) => {
      const quote = quotes[row.symbol];
      const rec = engine(row, quote);
      return applyCycleAction(account.id, {
        symbol: row.symbol,
        qty: row.qty,
        role: row.role,
        last: quote?.ok ? quote.last : row.last ?? null,
        changePct: quote?.ok ? quote.changePct : null,
        kind: 'position',
        ...rec
      }, cycles[row.symbol]);
    });
    for (const order of holdings.openOrders || []) {
      if (!String(order.symbol || '').trim()) continue;
      recommendations.push(attachStrategy(workingOrderRec(order), cycles[String(order.symbol || '').toUpperCase()]));
    }
    for (const opt of holdings.optionPositions || []) {
      const symbol = String(opt.symbol || '').toUpperCase();
      if (!symbol) continue;
      recommendations.push(attachStrategy({
        symbol,
        qty: opt.qty,
        role: `${opt.side || 'long'} ${opt.type || 'option'}`,
        last: opt.markPricePerShare ?? opt.estimatedValue ?? null,
        changePct: null,
        kind: 'position',
        action: 'REVIEW',
        title: '期权：核对剩余最大亏损',
        detail: `${symbol} ${opt.expiration || ''} ${opt.strike ?? ''} ${opt.type || ''}。Long 期权最大亏损=剩余权利金。禁止加裸卖。默认草稿。`,
        instrument: 'option',
        failBy: opt.expiration || '到期日',
        maxLoss: '剩余权利金（可亏光，不得变成无限责任）'
      }, { ok: false, id: 'cycle-of-price-action', name: 'Cycle of Price Action', stage: 'unknown', stageLabel: '期权不适用', score: null, note: '期权不套用股票价格周期' }));
    }
    const opportunities = pickOpportunities(account.id, universe, quotes, held, navHint, undefined, cycles);
    const paperCandidates = pickOpportunities(account.id, universe, quotes, held, navHint, 12, cycles)
      .map((row) => withPaperStop(account.id, row));
    const priorities = [
      ...recommendations.filter((row) => row.kind === 'working-order' || ['SELL', 'EXIT', 'TRIM', 'ADD', 'REVIEW', 'BUY'].includes(row.action)),
      ...opportunities.filter((row) => ['BUY', 'SELL', 'EXIT'].includes(row.action)).slice(0, account.id === 'agentic' && !recommendations.length ? 3 : 1)
    ]
      .slice(0, 3)
      .map((row) => ({
        symbol: row.symbol,
        action: row.action,
        title: row.title,
        strategy: row.strategy || null,
        strategyLabel: strategyLabel(row.strategy)
      }));
    if (!priorities.length) {
      priorities.push({
        symbol: '',
        action: 'WAIT',
        title: account.id === 'main' ? '无必须执行项。主账户今天可以不交易。' : '无必须执行项，保留现金或维持原仓。'
      });
    }
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      cash: holdings.cash,
      positionCount: (holdings.positions || []).length,
      asOf: holdings.asOf,
      stale: Boolean(holdings.stale),
      priorities,
      recommendations,
      opportunities,
      paperCandidates
    };
  });

  const payload = {
    date,
    advisor: 'grok',
    generatedAt: new Date().toISOString(),
    liveTrading: false,
    paperAuto: true,
    scan: {
      lists: universe.lists.map((row) => ({ file: row.file, title: row.title, bucket: row.bucket, count: row.count })),
      listSummary: universe.lists.length ? universe.lists.map((row) => `${row.title} ${row.count}`).join(' · ') : '清单缺失',
      symbolCount: universe.symbols.length,
      error: universe.error,
      cycle: {
        id: cycleBook.id,
        name: cycleBook.name,
        regime: cycleBook.regime,
        regimeLabel: cycleBook.regimeLabel,
        counted: cycleBook.counted,
        tradeable: cycleBook.tradeable
      }
    },
    accounts
  };
  paintWinRates(payload, await loadWatchScore());
  const markdown = renderRecMarkdown(date, payload);
  await writeRecFiles('grok', payload, markdown);
  return payload;
}

async function writeRecFiles(advisor, payload, markdown) {
  await ensureRecsDir(advisor);
  const dir = recsDir(advisor);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${payload.date}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, `${payload.date}.md`), markdown, 'utf8');
  if (advisor === 'grok') {
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(join(REPORTS_DIR, `${payload.date}-推荐操作.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(join(REPORTS_DIR, `${payload.date}-推荐操作.md`), markdown, 'utf8');
  }
}

const CHATGPT_REVIEW_MAIN = ['FPS', 'INFQ', 'CBRS', 'CCXI', 'VOYG'];
const CHATGPT_LEVERED_2X = new Set([
  'QLD', 'SSO', 'NVDL', 'USD', 'ROM', 'UYG', 'DIG', 'ERX', 'BOIL', 'AGQ',
  'AAOX', 'IREX', 'SPCH'
]);

function chatgptAction(accountId, row, quote) {
  const qty = Number(row.qty);
  const cost = row.cost != null ? Number(row.cost) : Number(row.avgCost || 0) * qty;
  if (accountId === 'main') {
    if (CHATGPT_REVIEW_MAIN.includes(row.symbol)) {
      return {
        action: 'REVIEW',
        title: '身份/职责待核验',
        detail: '手册：主账户不应长期堆未核验小票。REVIEW 不是卖单，模拟操作不自动成交。'
      };
    }
    if (qty <= 10 || (Number.isFinite(cost) && cost > 0 && cost < 3000)) {
      return {
        action: 'TRIM',
        title: '清理碎片仓',
        detail: '手册：观察仓/碎片对大账户几乎无贡献，优先清掉并补现金。不为每天有动作而留下。'
      };
    }
    return {
      action: 'HOLD',
      title: '维持',
      detail: '手册：不为每天有动作而交易。无逻辑破坏证据时默认不交易，不用机械 10% 止损。'
    };
  }
  if (accountId === 'tactical') {
    const is2x = CHATGPT_LEVERED_2X.has(String(row.symbol || '').toUpperCase())
      || /2X|2x/.test(row.name || '');
    if (qty <= 1) {
      return {
        action: 'TRIM',
        title: '清掉1股占位',
        detail: '手册：1 股观察仓占用决策带宽，应放 list 而不是占仓。'
      };
    }
    if (is2x && quote?.ok && quote.changePct <= -4) {
      return {
        action: 'SELL',
        title: '2x 工具趋势破坏',
        detail: `当日 ${quote.changePct.toFixed(1)}%。手册：杠杆 ETF 不是底仓，趋势破坏必须退出。`
      };
    }
    if (quote?.ok && quote.changePct <= -8) {
      return {
        action: 'SELL',
        title: '硬回撤止损',
        detail: `当日 ${quote.changePct.toFixed(1)}%。战术账户止损必须及时，打穿事先最大亏损就走。`
      };
    }
    if (is2x) {
      return {
        action: 'HOLD',
        title: '2x 工具，设好失效',
        detail: '手册允许 2 倍 ETF，但是战术工具不是长期底仓。不编造加仓。'
      };
    }
    return {
      action: 'HOLD',
      title: '维持，先写最大亏损',
      detail: '无新开仓指令。不编造买单。止盈可以慢，止损必须及时。'
    };
  }
  return {
    action: 'HOLD',
    title: '维持',
    detail: 'Agentic 手册允许实验，但不编造未写明数量的买单。'
  };
}

async function chatgptRecBooks() {
  const config = await loadAccounts('chatgpt');
  const books = [];
  for (const account of config.accounts) {
    books.push({ account, holdings: await loadHoldings(account) });
  }
  return books;
}

async function buildChatgptRecommendations({ force = false } = {}) {
  const date = todayStamp();
  if (!force) {
    const existing = await readJson(join(recsDir('chatgpt'), `${date}.json`));
    if (isNativeChatgptRec(existing)) {
      return {
        ...existing,
        preserved: true,
        preservedReason: '当天已有 ChatGPT 原生推荐（orders / daily-recommendation），引擎未覆盖。'
      };
    }
  }

  const universe = await loadUniverse();
  const books = await chatgptRecBooks();
  const heldAll = books.flatMap(({ holdings }) => (holdings.positions || []).map((row) => row.symbol));
  const symbols = [...new Set([
    ...heldAll,
    ...TOOL_OVERLAY.map((row) => row.symbol)
  ].filter(Boolean))];
  const quotes = await loadQuotes(symbols);
  const lastBySymbol = Object.fromEntries(symbols.map((s) => [s, quotes[s]?.ok ? quotes[s].last : null]));
  const cycleBook = await loadCycleBook(symbols, {
    bySymbol: universe.bySymbol || {},
    lastBySymbol,
    concurrency: 4
  });
  const cycles = cycleBook.bySymbol || {};

  const accounts = books.map(({ account, holdings }) => {
    const held = heldSet(holdings);
    const navHint = navHintOf(account, holdings);
    const recommendations = (holdings.positions || []).map((row) => {
      const quote = quotes[row.symbol];
      return attachStrategy({
        symbol: row.symbol,
        qty: row.qty,
        role: row.role || '',
        title: '',
        detail: '',
        last: quote?.ok ? quote.last : row.last ?? null,
        changePct: quote?.ok ? quote.changePct : null,
        kind: 'position',
        ...chatgptAction(account.id, row, quote)
      }, cycles[row.symbol]);
    });
    const opportunities = pickOpportunities(account.id, universe, quotes, held, navHint, undefined, cycles)
      .map((row) => ({ ...row, action: 'WATCH' }));
    const priorities = recommendations
      .filter((row) => ['SELL', 'TRIM', 'ADD', 'REVIEW'].includes(row.action))
      .slice(0, 3)
      .map((row) => ({
        symbol: row.symbol,
        action: row.action,
        title: row.title,
        strategy: row.strategy || null,
        strategyLabel: strategyLabel(row.strategy)
      }));
    if (!priorities.length) {
      priorities.push({
        symbol: '',
        action: account.id === 'agentic' ? 'WAIT' : 'WAIT',
        title: account.id === 'agentic'
          ? ((holdings.positions || []).length
            ? '无必须执行项，保留现金或维持原仓。'
            : '空仓。手册允许扫描，但今日不编造买单数量。')
          : account.id === 'main'
            ? '无必须执行项。主账户今天可以不交易。'
            : '无必须执行项，保留现金或维持原仓。'
      });
    }
    return {
      id: account.id,
      label: account.label,
      source: 'chatgpt-handbook-rec',
      cash: holdings.cash ?? (account.id === 'agentic' ? 5000 : null),
      positionCount: (holdings.positions || []).length,
      asOf: holdings.asOf,
      stale: Boolean(holdings.stale),
      priorities,
      recommendations,
      opportunities
    };
  });

  const payload = {
    date,
    advisor: 'chatgpt',
    generatedAt: new Date().toISOString(),
    liveTrading: false,
    scan: {
      lists: universe.lists.map((row) => ({ file: row.file, title: row.title, bucket: row.bucket, count: row.count })),
      listSummary: universe.lists.length ? universe.lists.map((row) => `${row.title} ${row.count}`).join(' · ') : '清单缺失',
      symbolCount: universe.symbols.length,
      error: universe.error,
      cycle: {
        id: cycleBook.id,
        name: cycleBook.name,
        regime: cycleBook.regime,
        regimeLabel: cycleBook.regimeLabel,
        counted: cycleBook.counted,
        tradeable: cycleBook.tradeable,
        note: 'ChatGPT 账只标注周期，不按周期改手册动作。'
      }
    },
    accounts
  };
  paintWinRates(payload, await loadWatchScore());
  const markdown = renderRecMarkdown(date, payload);
  await writeRecFiles('chatgpt', payload, markdown);
  return payload;
}

export async function buildRecommendations({ advisor = 'grok', force = false } = {}) {
  if (advisor === 'chatgpt') return buildChatgptRecommendations({ force });
  return buildGrokRecommendations();
}
