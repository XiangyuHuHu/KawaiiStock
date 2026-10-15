import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, OBSIDIAN_WATCH, REPORTS_DIR, chinaStamp, recsDir, todayStamp } from '../paths.js';
import { accountById, loadAccounts, loadHoldings } from '../holdings.js';
import { loadQuotes } from '../quotes.js';
import { paperDeskOf } from '../risk/limits.js';
import { canOpen } from '../risk/mode.js';
import { getPaperView, loadPaperLedger, placePaperOrder, quoteHeldOption, recordPaperSession, sweepPaperStops, trailPaperStop } from './desk.js';
import { paperEquityNeedsReference, regularPaperSession } from './execution.js';
import { hexagramLongs, oracleExit, optionPaperExit, qimenLongs, sameOptionContract } from './signals.js';
import { appendAudit } from '../risk/audit.js';
import { buildCurrentQimen } from '../oracle/qimen-current.js';
import { buildSymbolOracle } from '../oracle/symbols.js';
import { loadUniverse } from '../universe.js';
import { loadManyHistoricals } from '../historicals.js';
import { upcomingEarnings } from '../events.js';
import { MOMENTUM_ID, chandelierStop, closedBars, holdRankable, momentumExit, momentumSignal, momentumStop, momentumUniverse, rankMomentum, regimeOn, sizeMomentum } from './momentum.js';
import { fetchChinaQuotes } from '../screener/cn-market-data.mjs';
import { loadChinaOracleHistory } from '../oracle/cn-data.js';
import { LIMIT_PULLBACK, prepareXiaomeng, sizeLimitPullback, xiaomengExits } from './xiaomeng.js';
import {
  CLOSE,
  DESK_POLICY,
  OPEN,
  actionOf,
  drawdownPct,
  isChase,
  isCycleEntry,
  isHighOdds,
  isQualitySource,
  isStock,
  cycleSizeR,
  num,
  recBook,
  sizeAlpha,
  sizeTactical,
  sizeWealth,
  tacticalRank,
  tacticalStop,
  themeNotional,
  wealthRank,
  wealthStop,
  wealthTheme,
  WEALTH_THEMES,
  exitLabel,
  exitPlan
} from './policy.js';

const SESSION_NOTE = {
  wealth: '0A $1M 财富：止损及时，止盈可以慢，没卖点就拿着。过闸才成交。',
  tactical: '0B 进攻：止损及时，止盈分批。没卖点就拿着。不是实盘。',
  agentic: '0C Agentic Alpha：等赔率，没有 A 级就空仓。止损看失效，止盈让赢家跑。不是实盘。',
  oracle: '0D 算卦对照：$100k 纸上。偏涨试买。当日判断为跌并且有持仓就卖。不是预测，不是实盘。',
  options: '0E 期权账本：$100k 纸上。研究台已关闭，不按扫描开新仓。已有合约跌 20% 平仓，离开研究名单且涨了 40% 才止盈，临近到期平仓。不是实盘。',
  momentum: '0F Claude 动量：$100k 纸上。全 list 按 6 个月涨幅÷波动排名，SPY/QQQ 在 200 日线上才开新仓。每仓风险 1%，3×ATR 吊灯止损只上移；跌破 100 日线或掉出前 20 名就卖。不是实盘。',
  'xiaomeng-cn': '0G 小孟A股：¥10 万，3–4 只。涨停回调后放量站上 5 日线才买，跌破 10 日线或亏 6% 就清。不是实盘。',
  'xiaomeng-us': '0H 小孟美股：$10 万，规则同小孟A股。大涨板按当天上涨至少 8% 且收在高点附近。不是实盘。'
};

const REC_ID = { wealth: 'main', tactical: 'tactical', agentic: 'agentic' };

async function readAutoConfig() {
  try {
    const config = JSON.parse(await readFile(join(DATA_DIR, 'desk-config.json'), 'utf8'));
    const paper = config.paper || {};
    return {
      enabled: paper.autoAtOpen !== false,
      desks: Array.isArray(paper.desks) && paper.desks.length ? paper.desks.map(paperDeskOf) : ['0a', '0b', '0c', '0d', '0e', '0f', '0g', '0h']
    };
  } catch {
    return { enabled: true, desks: ['0a', '0b', '0c', '0d', '0e', '0f', '0g', '0h'] };
  }
}

function todayAutoBuys(ledger, date) {
  return (ledger.fills || []).filter((row) => (
    row.date === date
    && String(row.side).toLowerCase() === 'buy'
    && String(row.note || '').includes('paper-auto')
  )).length;
}

function alreadyFilled(ledger, date, symbol, side) {
  const want = side === 'buy' || side === 'add' ? 'buy' : 'sell';
  return (ledger.fills || []).some((row) => (
    row.date === date
    && row.symbol === symbol
    && String(row.side).toLowerCase() === want
    && String(row.note || '').includes('paper-auto')
  ));
}

function scanPool(book) {
  const rows = [...(book?.paperCandidates || []), ...(book?.opportunities || [])];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const symbol = String(row.symbol || '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ ...row, symbol });
  }
  return out;
}

function heldSet(ledger) {
  return new Set((ledger.positions || []).map((row) => String(row.symbol || '').toUpperCase()));
}

function collectWealth(main, ledger, blocked, policy) {
  const held = heldSet(ledger);
  const closes = [];
  const opens = [];
  const seen = new Set();
  const pool = scanPool(main);
  for (const row of [...(main?.recommendations || []), ...pool]) {
    const symbol = String(row.symbol || '').toUpperCase();
    const action = actionOf(row);
    if (!symbol || !isStock(row) || seen.has(`${symbol}:${action}`)) continue;
    seen.add(`${symbol}:${action}`);
    if (CLOSE.has(action) && held.has(symbol)) {
      closes.push({ symbol, action, last: num(row.last), failPrice: num(row.failPrice), title: row.title, source: 'main-rec' });
    }
    if (OPEN.has(action) && !held.has(symbol) && !blocked.has(symbol)) {
      opens.push({ symbol, action, last: num(row.last), failPrice: num(row.failPrice), title: row.title, source: 'main-rec' });
    }
  }
  if (opens.length < policy.maxNewOpens) {
    const ranked = pool
      .map((row) => ({ row, rank: wealthRank(row) }))
      .filter(({ row, rank }) => {
        const symbol = String(row.symbol || '').toUpperCase();
        return rank >= 2 && symbol && !held.has(symbol) && !blocked.has(symbol) && isStock(row);
      })
      .sort((a, b) => b.rank - a.rank);
    for (const { row } of ranked) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (opens.some((item) => item.symbol === symbol)) continue;
      const last = num(row.last);
      if (last == null) continue;
      opens.push({
        symbol,
        action: 'BUY',
        last,
        failPrice: num(row.failPrice),
        title: row.title || '主账户候选',
        source: 'wealth-opportunity'
      });
      if (opens.length >= policy.maxNewOpens) break;
    }
  }
  return { closes, opens: opens.slice(0, policy.maxNewOpens) };
}

function collectTactical(book, ledger, blocked, policy) {
  const held = heldSet(ledger);
  const closes = [];
  const opens = [];
  const seen = new Set();
  const pool = scanPool(book);
  for (const row of [...(book?.recommendations || []), ...pool]) {
    const symbol = String(row.symbol || '').toUpperCase();
    const action = actionOf(row);
    if (!symbol || !isStock(row) || seen.has(`${symbol}:${action}`)) continue;
    seen.add(`${symbol}:${action}`);
    if (CLOSE.has(action) && held.has(symbol)) {
      closes.push({ symbol, action, last: num(row.last), failPrice: num(row.failPrice), title: row.title, source: 'tactical-rec' });
    }
    if (OPEN.has(action) && !held.has(symbol) && !blocked.has(symbol)) {
      opens.push({ symbol, action, last: num(row.last), failPrice: num(row.failPrice), title: row.title, source: 'tactical-rec' });
    }
  }
  if (opens.length < policy.maxNewOpens) {
    const ranked = pool
      .map((row) => ({ row, rank: tacticalRank(row) }))
      .filter(({ row, rank }) => {
        const symbol = String(row.symbol || '').toUpperCase();
        return rank >= 2 && symbol && !held.has(symbol) && !blocked.has(symbol) && isStock(row);
      })
      .sort((a, b) => b.rank - a.rank);
    for (const { row } of ranked) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (opens.some((item) => item.symbol === symbol)) continue;
      const last = num(row.last);
      if (last == null) continue;
      opens.push({
        symbol,
        action: 'BUY',
        last,
        failPrice: num(row.failPrice),
        title: row.title || '进攻候选',
        source: 'tactical-opportunity'
      });
      if (opens.length >= policy.maxNewOpens) break;
    }
  }
  return { closes, opens: opens.slice(0, policy.maxNewOpens) };
}

function collectAgentic(book, ledger, blocked, policy) {
  const held = heldSet(ledger);
  const closes = [];
  const opens = [];
  const seen = new Set();
  const pool = scanPool(book);
  for (const row of [...(book?.recommendations || []), ...pool]) {
    const symbol = String(row.symbol || '').toUpperCase();
    const action = actionOf(row);
    if (!symbol || !isStock(row) || seen.has(`${symbol}:${action}`)) continue;
    seen.add(`${symbol}:${action}`);
    if ((CLOSE.has(action) || row.strategy?.stage === 'wedge-drop') && held.has(symbol)) {
      closes.push({
        symbol,
        action: CLOSE.has(action) ? action : 'SELL',
        last: num(row.last),
        failPrice: num(row.failPrice),
        title: row.title,
        source: 'rec',
        strategy: row.strategy
      });
    }
    if (action === 'BUY' && !held.has(symbol) && !blocked.has(symbol) && isCycleEntry(row) && !isChase(row, row.changePct, policy)) {
      opens.push({
        symbol,
        action,
        last: num(row.last),
        failPrice: num(row.failPrice) ?? num(row.strategy?.stop),
        title: row.title,
        source: 'rec',
        changePct: num(row.changePct),
        strategy: row.strategy
      });
    }
  }
  if (opens.length < policy.maxNewOpens) {
    for (const row of pool) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (!symbol || held.has(symbol) || blocked.has(symbol) || !isStock(row)) continue;
      if (!isCycleEntry(row)) continue;
      if (isQualitySource(row) && !isHighOdds(row) && !isCycleEntry(row)) continue;
      if (isChase(row, row.changePct, policy)) continue;
      if (opens.some((item) => item.symbol === symbol)) continue;
      const last = num(row.last);
      const stop = num(row.failPrice) ?? num(row.strategy?.stop);
      if (last == null || stop == null || stop >= last) continue;
      opens.push({
        symbol,
        action: 'BUY',
        last,
        failPrice: stop,
        title: row.title || 'Cycle 候选',
        source: 'cycle',
        changePct: num(row.changePct),
        strategy: row.strategy
      });
      if (opens.length >= policy.maxNewOpens) break;
    }
  }
  return { closes, opens: opens.slice(0, policy.maxNewOpens) };
}

async function execute(intent) {
  if (!regularPaperSession()) {
    return { ok: false, symbol: intent.symbol, side: intent.side, reason: 'outside-session', message: '非常规交易时段不下自动单；止损由日线回放处理' };
  }
  const result = await placePaperOrder(intent);
  if (!result.ok) {
    return {
      ok: false,
      symbol: intent.symbol,
      side: intent.side,
      reason: result.decision?.code || 'denied',
      message: result.decision?.message || 'Gateway 拒绝'
    };
  }
  return {
    ok: true,
    symbol: result.fill.symbol,
    side: result.fill.side,
    qty: result.fill.qty,
    price: result.fill.price,
    stopPrice: result.fill.stopPrice,
    maxLoss: result.fill.maxLoss,
    id: result.fill.id,
    replay: Boolean(result.replay)
  };
}

async function liveAccountSymbols(accountId) {
  try {
    const config = await loadAccounts('grok');
    const account = accountById(config, accountId);
    if (!account) return new Set();
    const book = await loadHoldings(account);
    return new Set((book.positions || []).map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function paperSymbols(desk) {
  const ledger = await loadPaperLedger(desk);
  return heldSet(ledger);
}

function recIndex(book) {
  const map = new Map();
  for (const row of [...(book?.recommendations || []), ...scanPool(book)]) {
    const symbol = String(row.symbol || '').toUpperCase();
    if (symbol) map.set(symbol, row);
  }
  return map;
}

function pickRows(style, book, ledger, blocked, policy) {
  if (style === 'wealth') return collectWealth(book, ledger, blocked, policy);
  if (style === 'tactical') return collectTactical(book, ledger, blocked, policy);
  return collectAgentic(book, ledger, blocked, policy);
}

/**
 * 单本纸上开盘。0A 财富 / 0B 进攻 / 0C Agentic。blockedSymbols 避免三本买同一逻辑。
 */
export async function runPaperSession({ date, recs, desk, force = false, blockedSymbols } = {}) {
  const config = await readAutoConfig();
  const id = paperDeskOf(desk || '0b');
  const policy = DESK_POLICY[id] || DESK_POLICY['0b'];
  const day = date || todayStamp();
  if (day !== todayStamp()) return { ok: false, liveTrading: false, note: '纸上当前报价撮合不能用于历史日期；请用独立历史验证' };
  const view = await getPaperView(id);
  const blocked = new Set([...(blockedSymbols || [])].map((s) => String(s).toUpperCase()));
  const session = {
    ok: true,
    liveTrading: false,
    auto: true,
    date: day,
    desk: id,
    style: policy.style,
    mode: view.mode,
    fills: [],
    skipped: [],
    reviews: [],
    note: SESSION_NOTE[policy.style] || SESSION_NOTE.agentic
  };

  if (!config.enabled && !force) {
    session.skipped.push({ reason: 'disabled', message: 'desk-config.paper.autoAtOpen=false' });
    return session;
  }
  if (view.mode === 'KILL') {
    session.skipped.push({ reason: 'kill', message: 'KILL：仍会打已有止损，不再开新仓。' });
  }

  const ledger = await loadPaperLedger(id);
  const symbols = [...new Set((ledger.positions || []).map((row) => row.symbol).filter(Boolean))];
  const quotes = symbols.length ? await loadQuotes(symbols) : {};
  const dd = drawdownPct(view.ledger.nav, view.ledger.peakNav);

  let book = recBook(recs, policy.recId || REC_ID[policy.style] || 'agentic');
  if (!book) {
    try {
      book = recBook(await ensureDayRecs(day), policy.recId || REC_ID[policy.style] || 'agentic');
    } catch (error) {
      session.skipped.push({ reason: 'recs-unavailable', message: error.message });
      return finish(id, session, await loadPaperLedger(id));
    }
  }
  const recsMap = recIndex(book);
  for (const pos of ledger.positions || []) {
    const last = quotes[pos.symbol]?.ok ? quotes[pos.symbol].last : null;
    const plan = exitPlan(pos, last, recsMap.get(pos.symbol), policy);
    session.reviews.push({
      symbol: pos.symbol,
      action: plan.action,
      reason: plan.reason,
      qty: plan.qty,
      trail: plan.trail,
      label: exitLabel(plan)
    });
    if (plan.action === 'HOLD') {
      if (plan.trail) {
        const trailed = await trailPaperStop(id, pos.symbol, plan.trail);
        if (trailed.ok) {
          session.skipped.push({ symbol: pos.symbol, side: 'hold', reason: 'trail', message: `止损上移到 ${plan.trail}，继续拿` });
        }
      }
      continue;
    }
    if (last == null) {
      session.skipped.push({ symbol: pos.symbol, side: 'sell', reason: 'data-missing', message: '有卖点但没有新鲜报价' });
      continue;
    }
    const tag = plan.reason === 'stop' ? 'stop' : (plan.reason === 'tp' || plan.reason === 'rec-tp' ? 'tp' : 'exit');
    if (tag !== 'stop' && alreadyFilled(ledger, day, pos.symbol, 'sell')) continue;
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${pos.symbol}:${tag}`,
      symbol: pos.symbol,
      side: 'sell',
      qty: plan.qty,
      limitPrice: (((!paperEquityNeedsReference(quotes[pos.symbol]) && quotes[pos.symbol]?.bid > 0) ? Math.min(quotes[pos.symbol].bid, last) : last) * 0.998),
      stopPrice: pos.stopPrice,
      maxLoss: pos.maxLoss,
      instrument: pos.instrument || 'equity',
      reduceOnly: true,
      paperReference: paperEquityNeedsReference(quotes[pos.symbol]),
      note: `paper-auto-${plan.reason}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
    if (out.ok && plan.trail) await trailPaperStop(id, pos.symbol, plan.trail);
  }

  if (!book) {
    session.skipped.push({
      reason: 'no-recs',
      message: `${id} 没有对应推荐，已处理止损/止盈，不再开新仓。`
    });
    return finish(id, session, await loadPaperLedger(id));
  }

  const fresh = await loadPaperLedger(id);
  const picked = pickRows(policy.style, book, fresh, blocked, policy);

  if (!canOpen(view.mode)) {
    session.skipped.push({ reason: view.mode, message: `${view.mode} 禁止新开仓。` });
    return finish(id, session, await loadPaperLedger(id));
  }
  if (policy.pauseNewAtDrawdownPct != null && dd >= policy.pauseNewAtDrawdownPct) {
    session.skipped.push({ reason: 'drawdown', message: `${id} 回撤 ${dd.toFixed(1)}%，停止新开，进入复查。` });
    return finish(id, session, await loadPaperLedger(id));
  }
  const navNow = Number(ledger.nav) || 0;
  const dayPnl = Number(view.book?.realizedPnlToday || 0);
  const dayLossPct = navNow > 0 ? Math.max(0, (-dayPnl / navNow) * 100) : 0;
  if (policy.pauseNewAtDailyLossPct != null && dayLossPct >= policy.pauseNewAtDailyLossPct) {
    session.skipped.push({ reason: 'daily-loss', message: `${id} 单日亏损 ${dayLossPct.toFixed(1)}%，当天不再新开高风险仓。` });
    return finish(id, session, await loadPaperLedger(id));
  }

  const after = await loadPaperLedger(id);
  if ((after.positions || []).length >= policy.maxPositions) {
    session.skipped.push({ reason: 'max-positions', message: `${id} 持仓数已达 ${policy.maxPositions}` });
    return finish(id, session, after);
  }

  let cash = Number(after.cash) || 0;
  const nav = Number(after.nav) || 0;
  let openedToday = todayAutoBuys(after, day);
  for (const row of picked.opens) {
    if (openedToday >= (policy.maxNewOpens || 0)) {
      session.skipped.push({ symbol: row.symbol, side: 'buy', reason: 'max-new-opens', message: `${id} 今日新开已达 ${policy.maxNewOpens}` });
      continue;
    }
    if (alreadyFilled(after, day, row.symbol, 'buy') || blocked.has(row.symbol)) {
      session.skipped.push({ symbol: row.symbol, side: 'buy', reason: 'duplicate', message: '今日已开或与另一本账重复' });
      continue;
    }
    const q = await loadQuotes([row.symbol]);
    const last = q[row.symbol]?.ok ? q[row.symbol].last : null;
    const changePct = q[row.symbol]?.ok ? q[row.symbol].changePct : row.changePct;
    if (policy.style === 'agentic' && isChase(row, changePct, policy)) {
      session.skipped.push({ symbol: row.symbol, side: 'buy', reason: 'chase', message: `已涨 ${Number(changePct).toFixed(1)}%，禁止追高` });
      continue;
    }
    const stop = policy.style === 'wealth'
      ? wealthStop(last, row.strategy?.stop ?? row.failPrice, policy)
      : tacticalStop(last, row.strategy?.stop ?? row.failPrice, policy);
    if (last == null || stop == null || stop >= last) {
      session.skipped.push({ symbol: row.symbol, side: 'buy', reason: 'incomplete', message: '缺现价或失效价' });
      continue;
    }
    let sized;
    if (policy.style === 'wealth') {
      const theme = wealthTheme(row.symbol);
      const cap = theme === 'other' ? null : nav * (WEALTH_THEMES[theme]?.cap || 0.15);
      sized = sizeWealth(last, stop, nav, cash, policy, themeNotional(after.positions, theme), cap);
    } else if (policy.style === 'tactical') {
      const theme = wealthTheme(row.symbol);
      sized = sizeTactical(last, stop, nav, cash, policy, themeNotional(after.positions, theme));
    } else {
      sized = sizeAlpha(last, stop, nav, cash, policy, dd, cycleSizeR(row));
    }
    if (!sized) {
      const why = policy.style === 'wealth'
        ? '现金底线或主题上限不够做第一笔 30%'
        : policy.style === 'tactical'
          ? '现金底线或主题上限不够做第一笔 6%'
          : '现金底线 25% 不够，或回撤后不再加仓。空仓合法。';
      session.skipped.push({ symbol: row.symbol, side: 'buy', reason: 'size', message: why });
      continue;
    }
    const ask = q[row.symbol]?.ask;
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${row.symbol}:buy`,
      symbol: row.symbol,
      side: 'buy',
      qty: sized.qty,
      limitPrice: (ask > 0 ? ask : last) * 1.002,
      stopPrice: stop,
      maxLoss: sized.maxLoss,
      instrument: 'equity',
      theme: wealthTheme(row.symbol),
      note: `paper-auto-${row.source}:${row.strategy?.stage || 'none'}:${row.strategy?.score ?? ''}`,
      strategy: row.strategy || null
    });
    (out.ok ? session.fills : session.skipped).push(out);
    if (out.ok && !out.replay) {
      cash -= out.price * out.qty;
      openedToday += 1;
    }
  }

  if (!session.fills.length && !session.skipped.length) {
    session.note = `${id} 开盘自动跑过：没有卖点，继续拿着。`;
  }
  return finish(id, session, await loadPaperLedger(id));
}

function desksWanted(desk, config) {
  const text = String(desk || 'all').toLowerCase();
  if (!text || text === 'all') return config.desks;
  return [paperDeskOf(desk)];
}

function openedBuys(session) {
  return new Set((session?.fills || []).filter((row) => row.ok && row.side === 'buy').map((row) => row.symbol));
}

function blankSession(id, policy, day, mode) {
  return {
    ok: true,
    liveTrading: false,
    auto: true,
    date: day,
    desk: id,
    style: policy.style,
    mode,
    fills: [],
    skipped: [],
    reviews: [],
    note: SESSION_NOTE[policy.style] || ''
  };
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureDayRecs(day) {
  const file = await readJsonFile(join(recsDir('grok'), `${day}.json`));
  if (file?.date === day && Array.isArray(file.accounts) && file.accounts.length) return file;
  if (file) return null;
  const { buildRecommendations } = await import('../recommend.js');
  const built = await buildRecommendations({ advisor: 'grok' });
  if (built?.date === day && Array.isArray(built.accounts) && built.accounts.length) return built;
  return null;
}

async function ensureDayWatch(day) {
  const watchFile = await readJsonFile(join(OBSIDIAN_WATCH, `${day}.json`));
  if (watchFile?.date === day) return watchFile;
  const report = await readJsonFile(join(REPORTS_DIR, `${day}-每日观察.json`));
  if (report?.date === day) return report;
  if (watchFile || report) return null;
  const { buildAndWriteWatchlist } = await import('../strategy/watchlist.js');
  const built = await buildAndWriteWatchlist({ date: day });
  return built?.date === day ? built : null;
}

export async function loadOracleSupport(day) {
  const confirmed = new Set();
  const buys = new Set();
  let watch = null;
  let rec = null;
  let watchError = null;
  let recError = null;
  try {
    watch = await ensureDayWatch(day);
  } catch (error) {
    watchError = error.message;
  }
  try {
    rec = await ensureDayRecs(day);
  } catch (error) {
    recError = error.message;
  }
  for (const list of Object.values(watch?.boards || {})) {
    for (const row of list || []) {
      if (row?.allowNewLong) confirmed.add(String(row.symbol || '').toUpperCase());
    }
  }
  for (const account of rec?.accounts || []) {
    for (const row of [...(account.recommendations || []), ...(account.opportunities || []), ...(account.paperCandidates || [])]) {
      const action = String(row.action || row.side || '').toUpperCase();
      if (action === 'BUY' || action === 'ADD') buys.add(String(row.symbol || '').toUpperCase());
    }
  }
  return {
    confirmed,
    buys,
    watchDate: watch ? day : null,
    recDate: rec ? day : null,
    watchError,
    recError
  };
}

/** 0D：卦象偏涨优先，其次九宫偏涨。盘中按实时价，休市按最近成交价记纸上仓。 */
export async function runOracleSession({ date, force = false } = {}) {
  const config = await readAutoConfig();
  const id = '0d';
  const policy = DESK_POLICY[id];
  const day = date || todayStamp();
  const view = await getPaperView(id);
  const session = blankSession(id, policy, day, view.mode);
  if (day !== todayStamp()) {
    session.ok = false;
    session.note = '纸上当前报价撮合不能用于历史日期';
    return session;
  }
  if (!config.enabled && !force) {
    session.skipped.push({ reason: 'disabled', message: 'desk-config.paper.autoAtOpen=false' });
    return finish(id, session, await loadPaperLedger(id));
  }
  let chart;
  try {
    chart = await buildCurrentQimen({ scope: 'us' });
  } catch (error) {
    session.skipped.push({ reason: 'oracle-unavailable', message: error.message });
    return finish(id, session, await loadPaperLedger(id));
  }
  session.sources = { oracleDate: chart.date, oracleEffectiveAt: chart.effectiveAt, watchDate: null, recDate: null };
  let hexRows = [];
  let hexAll = [];
  try {
    const hex = await buildSymbolOracle({ date: day, market: 'us' });
    hexAll = hex.rows || [];
    hexRows = hexagramLongs(hexAll);
    session.sources.hexDate = hex.date;
    session.sources.hexUp = hexRows.map((row) => row.symbol);
  } catch (error) {
    session.sources.hexError = error.message;
  }
  const bySymbol = new Map(qimenLongs(chart.rows).map((row) => [row.symbol, row]));
  for (const row of hexRows) bySymbol.set(row.symbol, { ...bySymbol.get(row.symbol), ...row, source: 'hex' });
  const all = new Map((chart.rows || []).filter((row) => row.market === 'us').map((row) => [String(row.symbol).toUpperCase(), row]));
  for (const row of hexAll) {
    if (row.direction !== 'down') continue;
    const symbol = String(row.symbol || '').toUpperCase();
    all.set(symbol, { ...(all.get(symbol) || {}), symbol, market: 'us', direction: 'down', score: -2 });
  }
  const ledger = await loadPaperLedger(id);
  const symbols = [...new Set((ledger.positions || []).map((row) => row.symbol).filter(Boolean))];
  const quotes = symbols.length ? await loadQuotes(symbols) : {};
  for (const pos of ledger.positions || []) {
    const signal = all.get(pos.symbol);
    const quote = quotes[pos.symbol];
    const last = quote?.ok ? quote.last : null;
    const flipped = oracleExit(signal);
    const plan = flipped
      ? { action: 'SELL', reason: 'logic-exit', qty: pos.qty, trail: null }
      : exitPlan(pos, last, null, policy);
    session.reviews.push({ symbol: pos.symbol, action: plan.action, reason: plan.reason, qty: plan.qty, label: flipped ? '当日判断为跌，卖出' : exitLabel(plan) });
    if (plan.action === 'HOLD') {
      if (plan.trail) await trailPaperStop(id, pos.symbol, plan.trail);
      continue;
    }
    if (last == null) {
      session.skipped.push({ symbol: pos.symbol, side: 'sell', reason: 'data-missing', message: '有卖点但没有股票报价' });
      continue;
    }
    const reference = paperEquityNeedsReference(quote);
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${pos.symbol}:${flipped ? 'oracle-down' : plan.reason}`,
      symbol: pos.symbol,
      side: 'sell',
      qty: plan.qty,
      limitPrice: last * 0.998,
      stopPrice: pos.stopPrice,
      maxLoss: pos.maxLoss,
      instrument: 'equity',
      reduceOnly: true,
      paperReference: reference,
      note: flipped ? 'paper-auto-oracle-down' : `paper-auto-${plan.reason}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
  }
  if (!canOpen(view.mode)) {
    session.skipped.push({ reason: view.mode, message: `${view.mode} 禁止新开仓。` });
    return finish(id, session, await loadPaperLedger(id));
  }
  const fresh = await loadPaperLedger(id);
  const held = new Set((fresh.positions || []).map((row) => row.symbol));
  let opened = todayAutoBuys(fresh, day);
  let cash = Number(fresh.cash) || 0;
  const nav = Number(fresh.nav) || cash;
  const support = await loadOracleSupport(day);
  session.sources.watchDate = support.watchDate;
  session.sources.recDate = support.recDate;
  const leaning = [...bySymbol.values()].filter((row) => !held.has(row.symbol));
  const confluence = (row) => Number(support.confirmed.has(row.symbol)) + Number(support.buys.has(row.symbol));
  const candidates = leaning
    .filter((row) => row.source === 'hex' || row.source === 'qimen')
    .sort((a, b) => confluence(b) - confluence(a) || Number(b.source === 'hex') - Number(a.source === 'hex') || b.score - a.score || a.symbol.localeCompare(b.symbol));
  if (!candidates.length) session.skipped.push({ reason: 'no-oracle-long', message: '九宫和卦象关注名单里都没有偏涨，不开新仓。' });
  const quoteMap = candidates.length ? await loadQuotes(candidates.map((row) => row.symbol)) : {};
  for (const row of candidates) {
    if (opened >= policy.maxNewOpens || held.size >= policy.maxPositions) break;
    const quote = quoteMap[row.symbol];
    const last = quote?.ok ? quote.last : null;
    if (!(last > 0)) {
      session.skipped.push({ symbol: row.symbol, reason: 'quote-unavailable', message: '没有股票报价' });
      continue;
    }
    const stop = Number((last * (1 - policy.invalidationPct)).toFixed(2));
    const sized = sizeTactical(last, stop, nav, cash, policy, 0);
    if (!sized) {
      session.skipped.push({ symbol: row.symbol, reason: 'size', message: '现金或仓位不够' });
      continue;
    }
    const reference = paperEquityNeedsReference(quote);
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${row.symbol}:oracle`,
      symbol: row.symbol,
      side: 'buy',
      qty: sized.qty,
      limitPrice: last * 1.002,
      stopPrice: stop,
      maxLoss: sized.maxLoss,
      instrument: 'equity',
      theme: 'oracle',
      paperReference: reference,
      note: `paper-auto-oracle:${row.source === 'hex' ? 'hex' : row.men}:${row.score}:c${confluence(row)}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
    const skipCode = out.decision?.code || out.reason;
    if (!out.ok && ['quote-stale', 'outside-session'].includes(skipCode)) {
      session.skipped.push({ reason: skipCode, message: '报价不在可成交窗口，其余偏涨本轮不再尝试。' });
      break;
    }
    if (out.ok && !out.replay) {
      cash -= out.price * out.qty;
      opened += 1;
      held.add(row.symbol);
    }
  }
  return finish(id, session, await loadPaperLedger(id));
}

/** 0E：期权研究台已关闭。不新开仓。已有合约仍按权利金止损、离开研究名单后的止盈、以及到期前平仓。 */
export async function runOptionSession({ date, force = false } = {}) {
  const config = await readAutoConfig();
  const id = '0e';
  const policy = DESK_POLICY[id];
  const day = date || todayStamp();
  const view = await getPaperView(id);
  const session = blankSession(id, policy, day, view.mode);
  session.note = '期权研究台已关闭。0E 不新开仓；已有合约仍按止损、止盈和到期处理。不是实盘。';
  if (day !== todayStamp()) {
    session.ok = false;
    session.note = '纸上当前报价撮合不能用于历史日期';
    return session;
  }
  if (!config.enabled && !force) {
    session.skipped.push({ reason: 'disabled', message: 'desk-config.paper.autoAtOpen=false' });
    return finish(id, session, await loadPaperLedger(id));
  }
  session.sources = { optionsResearch: false };
  const ledger = await loadPaperLedger(id);
  const gainPct = policy.takeProfitPct ?? 0.4;
  const lossPct = policy.stopLossPct ?? 0.2;
  for (const pos of ledger.positions || []) {
    if (String(pos.instrument || 'option') === 'equity') continue;
    const live = await quoteHeldOption(pos);
    const bid = Number(live?.bid);
    const ask = Number(live?.ask);
    const openedOn = (ledger.fills || [])
      .filter((row) => row.side === 'buy' && row.date && sameOptionContract(row, pos))
      .map((row) => row.date)
      .sort()[0] || null;
    const daysLeft = Math.round((Date.parse(`${pos.expiration}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
    const exitKind = Number.isFinite(daysLeft) && daysLeft <= 1 ? 'expiry' : optionPaperExit({
      avgCost: pos.avgCost,
      bid,
      ask,
      listed: false,
      openedBeforeToday: Boolean(openedOn) && openedOn < day,
      gainPct,
      lossPct
    });
    const tag = pos.optionType || pos.right;
    if (!exitKind) {
      session.reviews.push({
        symbol: pos.symbol, expiration: pos.expiration, strike: pos.strike, optionType: tag,
        action: 'HOLD', reason: 'hold',
        label: Number(bid) > 0 ? '研究台已关闭，涨幅未到止盈且未跌破止损，继续拿' : '没有这张合约的 Bid，不能确认涨跌，继续拿'
      });
      continue;
    }
    if (!(bid > 0) || !(ask > 0)) {
      session.reviews.push({
        symbol: pos.symbol, expiration: pos.expiration, strike: pos.strike, optionType: tag,
        action: 'REVIEW', reason: 'contract-quote-required', label: '有卖点但没有这张合约的 Bid'
      });
      session.skipped.push({ symbol: pos.symbol, side: 'sell', reason: 'contract-quote-required', message: '这张合约没有可验证的 Bid/Ask，不能用正股价格代替期权平仓价' });
      continue;
    }
    const exitText = { stop: '权利金跌了 20%，平仓', tp: '研究台已关闭，并且涨了 40%，卖出', expiry: '离到期不到 1 天，平仓，不拿到期' };
    session.reviews.push({
      symbol: pos.symbol, expiration: pos.expiration, strike: pos.strike, optionType: tag,
      action: 'SELL', reason: exitKind, label: exitText[exitKind]
    });
    const legAt = Number(live?.quoteAt) > 0 ? Number(live.quoteAt) : null;
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${pos.symbol}:${pos.expiration}:${pos.strike}:${exitKind}`,
      symbol: pos.symbol,
      side: 'sell',
      qty: pos.qty,
      instrument: 'option',
      optionType: tag,
      expiration: pos.expiration,
      strike: pos.strike,
      bid,
      ask,
      quoteAt: legAt,
      quoteMode: live?.quoteMode || null,
      paperReference: paperEquityNeedsReference({ quoteAt: legAt, last: bid }),
      limitPrice: bid * 0.998,
      stopPrice: pos.stopPrice,
      maxLoss: pos.maxLoss,
      reduceOnly: true,
      structure: 'long',
      type: 'limit',
      note: { stop: 'paper-auto-option-stop20', tp: 'paper-auto-option-tp40', expiry: 'paper-auto-option-expiry' }[exitKind]
    });
    (out.ok ? session.fills : session.skipped).push(out);
  }
  session.skipped.push({ reason: 'options-research-off', message: '期权研究台已关闭，不再根据扫描开新仓。' });
  return finish(id, session, await loadPaperLedger(id));
}

/** 0F：全 list 波动调整动量排名，趋势龙头轮动。和推荐、算卦、期权都无关。 */
export async function runMomentumSession({ date, force = false } = {}) {
  const config = await readAutoConfig();
  const id = '0f';
  const policy = DESK_POLICY[id];
  const day = date || todayStamp();
  const view = await getPaperView(id);
  const session = blankSession(id, policy, day, view.mode);
  if (day !== todayStamp()) {
    session.ok = false;
    session.note = '纸上当前报价撮合不能用于历史日期';
    return session;
  }
  if (!config.enabled && !force) {
    session.skipped.push({ reason: 'disabled', message: 'desk-config.paper.autoAtOpen=false' });
    return finish(id, session, await loadPaperLedger(id));
  }
  const universe = await loadUniverse();
  const ledger = await loadPaperLedger(id);
  const heldSymbols = (ledger.positions || []).map((row) => row.symbol);
  const names = momentumUniverse([...(universe.symbols || []).map((row) => row.symbol), ...heldSymbols]);
  const history = await loadManyHistoricals([...names, 'SPY', 'QQQ'], { concurrency: 4 });
  const barsOf = (symbol) => closedBars(history[symbol]?.bars, day);
  const signals = Object.fromEntries(names.map((symbol) => [symbol, momentumSignal(barsOf(symbol))]));
  const ranked = rankMomentum(signals);
  const rankOf = new Map(rankMomentum(holdRankable(signals)).map((row) => [row.symbol, row.rank]));
  const regime = regimeOn(barsOf('SPY'), barsOf('QQQ'));
  session.sources = {
    strategy: MOMENTUM_ID,
    scanned: names.length,
    eligible: ranked.length,
    regime: regime ? 'risk-on' : 'risk-off',
    top: ranked.slice(0, 10).map((row) => ({ symbol: row.symbol, rank: row.rank, score: row.score, ret: row.ret, vol: row.vol }))
  };

  const quotes = await loadQuotes([...new Set([...heldSymbols, ...ranked.slice(0, policy.keepRank).map((row) => row.symbol)])]);
  for (const pos of ledger.positions || []) {
    const signal = signals[pos.symbol];
    const quote = quotes[pos.symbol];
    const last = quote?.ok ? quote.last : null;
    const openedOn = (ledger.fills || []).filter((row) => row.side === 'buy' && row.symbol === pos.symbol).map((row) => row.date).sort()[0] || null;
    const chand = chandelierStop(barsOf(pos.symbol), openedOn, signal?.atr, policy.atrMult);
    const stop = Math.max(Number(pos.stopPrice) || 0, chand && last && chand < last ? Number(chand.toFixed(2)) : 0);
    const rank = rankOf.get(pos.symbol) ?? null;
    const kind = momentumExit({ last, stop, signal, rank, keepRank: policy.keepRank });
    const label = {
      stop: `跌到吊灯止损 ${stop.toFixed(2)}，卖出`,
      trend: '收盘跌破 100 日线，趋势破坏，卖出',
      rank: `动量排名 ${rank ?? '不合格'}，掉出前 ${policy.keepRank}，换仓`
    }[kind] || `排名 ${rank ?? '—'}，止损 ${stop ? stop.toFixed(2) : '—'}，继续拿`;
    session.reviews.push({ symbol: pos.symbol, action: kind ? 'SELL' : 'HOLD', reason: kind || 'hold', rank, label });
    if (!kind) {
      if (stop > (Number(pos.stopPrice) || 0) + 0.005) await trailPaperStop(id, pos.symbol, stop);
      continue;
    }
    if (last == null) {
      session.skipped.push({ symbol: pos.symbol, side: 'sell', reason: 'data-missing', message: '有卖点但没有股票报价' });
      continue;
    }
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${pos.symbol}:${kind}`,
      symbol: pos.symbol,
      side: 'sell',
      qty: pos.qty,
      limitPrice: last * 0.998,
      stopPrice: pos.stopPrice,
      maxLoss: pos.maxLoss,
      instrument: 'equity',
      reduceOnly: true,
      paperReference: paperEquityNeedsReference(quote),
      note: `paper-auto-momentum-${kind}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
  }

  if (!canOpen(view.mode)) {
    session.skipped.push({ reason: view.mode, message: `${view.mode} 禁止新开仓。` });
    return finish(id, session, await loadPaperLedger(id));
  }
  if (!regime) {
    session.skipped.push({ reason: 'risk-off', message: 'SPY 或 QQQ 在 200 日线下方，不开新仓，只管止损。' });
    return finish(id, session, await loadPaperLedger(id));
  }
  const fresh = await loadPaperLedger(id);
  const held = new Set((fresh.positions || []).map((row) => row.symbol));
  let opened = todayAutoBuys(fresh, day);
  let cash = Number(fresh.cash) || 0;
  const nav = Number(fresh.nav) || cash;
  const earnings = await upcomingEarnings(3);
  if (!ranked.length) session.skipped.push({ reason: 'no-momentum', message: '全 list 没有通过趋势和流动性过滤的名字。' });
  for (const row of ranked.slice(0, policy.keepRank)) {
    if (opened >= policy.maxNewOpens || held.size >= policy.maxPositions) break;
    if (held.has(row.symbol)) continue;
    const quote = quotes[row.symbol];
    const last = quote?.ok ? quote.last : null;
    if (!(last > 0)) {
      session.skipped.push({ symbol: row.symbol, reason: 'quote-unavailable', message: '没有股票报价' });
      continue;
    }
    if (Number(quote.changePct) >= policy.noChasePct) {
      session.skipped.push({ symbol: row.symbol, reason: 'chase', message: `当日已涨 ${Number(quote.changePct).toFixed(1)}%，不追` });
      continue;
    }
    if (earnings.has(row.symbol)) {
      session.skipped.push({ symbol: row.symbol, reason: 'earnings', message: `${earnings.get(row.symbol)} 财报，先不进` });
      continue;
    }
    const stop = momentumStop(last, row.atr, policy.atrMult);
    const sized = sizeMomentum({ nav, cash, price: last, stop, riskPct: policy.riskPct, maxNamePct: policy.maxNamePct, cashFloorPct: policy.cashFloorPct });
    if (!sized) {
      session.skipped.push({ symbol: row.symbol, reason: 'size', message: '现金或仓位不够' });
      continue;
    }
    const out = await execute({
      desk: id,
      id: `paper-auto:${day}:${id}:${row.symbol}:momentum`,
      symbol: row.symbol,
      side: 'buy',
      qty: sized.qty,
      limitPrice: last * 1.002,
      stopPrice: stop,
      maxLoss: sized.maxLoss,
      instrument: 'equity',
      paperReference: paperEquityNeedsReference(quote),
      note: `paper-auto-momentum:rank${row.rank}:score${row.score}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
    if (out.ok && !out.replay) {
      cash -= out.price * out.qty;
      opened += 1;
      held.add(row.symbol);
    }
  }
  return finish(id, session, await loadPaperLedger(id));
}

async function chinaStopLoader(symbol) {
  try {
    const pack = await loadChinaOracleHistory(symbol);
    return pack?.ok ? pack : { ok: false, bars: [] };
  } catch {
    return { ok: false, bars: [] };
  }
}

/** 每日任务传入的是美东日期。0G 仍按北京日期跑；只有明确的历史日才拒绝撮合。 */
export function xiaomengSessionDay(desk, date, clocks = {}) {
  const id = desk === '0g' ? '0g' : '0h';
  const us = clocks.usToday || todayStamp();
  const cn = clocks.cnToday || chinaStamp();
  const marketToday = id === '0g' ? cn : us;
  if (!date || date === us || date === cn) return marketToday;
  return date;
}

/** 0G 小孟A股 / 0H 小孟美股。涨停或大涨后的回调低吸，不占 0A–0C 名额。 */
export async function runXiaomengSession({ date, force = false, desk = '0h' } = {}) {
  const config = await readAutoConfig();
  const id = desk === '0g' ? '0g' : '0h';
  const policy = DESK_POLICY[id];
  const day = xiaomengSessionDay(id, date);
  const expected = id === '0g' ? chinaStamp() : todayStamp();
  const view = await getPaperView(id);
  const session = blankSession(id, policy, day, view.mode);
  if (day !== expected) {
    session.ok = false;
    session.note = '纸上当前报价撮合不能用于历史日期';
    return session;
  }
  if (!config.enabled && !force) {
    session.skipped.push({ reason: 'disabled', message: 'desk-config.paper.autoAtOpen=false' });
    return finish(id, session, await loadPaperLedger(id));
  }
  const prepared = await prepareXiaomeng(id);
  const ledger = await loadPaperLedger(id);
  session.sources = {
    strategy: LIMIT_PULLBACK.id,
    market: prepared.market,
    scanned: prepared.scanned,
    eligible: prepared.buys.length,
    l2: '封单、DDE、集合竞价没有数据源，这些条件不假装通过',
    names: prepared.buys.slice(0, 6).map((row) => `${row.symbol}:${row.shape}:${row.boards}板`)
  };
  const exits = xiaomengExits(ledger, prepared.barsBySymbol, prepared);
  const quoteSymbols = [...new Set([
    ...exits.filter((row) => row.action !== 'HOLD').map((row) => row.symbol),
    ...prepared.buys.map((row) => row.symbol),
    ...(ledger.positions || []).map((row) => row.symbol)
  ])];
  const quoteMap = new Map();
  if (id === '0g') {
    const quotes = quoteSymbols.length ? await fetchChinaQuotes(quoteSymbols.map((symbol) => ({ symbol }))) : new Map();
    for (const symbol of quoteSymbols) {
      const row = quotes.get(symbol);
      quoteMap.set(symbol, { ok: row?.price > 0, last: row?.price ?? null, quoteAt: row?.marketDate || null });
    }
  } else {
    const quotes = await loadQuotes(quoteSymbols);
    for (const symbol of quoteSymbols) quoteMap.set(symbol, quotes[symbol]);
  }
  for (const plan of exits) {
    session.reviews.push({ symbol: plan.symbol, action: plan.action, reason: plan.reason, label: plan.label });
    if (plan.action === 'HOLD') continue;
    const quote = quoteMap.get(plan.symbol);
    const last = quote?.ok ? quote.last : plan.price;
    if (!(last > 0)) {
      session.skipped.push({ symbol: plan.symbol, side: 'sell', reason: 'quote-unavailable', message: '有卖点但没有报价' });
      continue;
    }
    const out = await placePaperOrder({
      desk: id,
      id: `paper-auto:${day}:${id}:${plan.symbol}:${plan.reason}`,
      symbol: plan.symbol,
      side: 'sell',
      qty: plan.qty,
      limitPrice: last * 0.998,
      stopPrice: null,
      maxLoss: null,
      instrument: 'equity',
      reduceOnly: true,
      paperReference: id === '0g' || paperEquityNeedsReference(quote),
      note: `paper-auto-xiaomeng:${plan.reason}`
    });
    (out.ok ? session.fills : session.skipped).push(out);
  }
  if (!canOpen(view.mode)) {
    session.skipped.push({ reason: view.mode, message: `${view.mode} 禁止新开仓。` });
    return finish(id, session, await loadPaperLedger(id));
  }
  const fresh = await loadPaperLedger(id);
  const held = new Set((fresh.positions || []).map((row) => row.symbol));
  let opened = (fresh.fills || []).filter((row) => row.side === 'buy' && String(row.date || '').slice(0, 10) === day && String(row.note || '').includes('xiaomeng')).length;
  let cash = Number(fresh.cash) || 0;
  const nav = Number(fresh.nav) || cash;
  if (!prepared.buys.length) session.skipped.push({ reason: 'no-setup', message: prepared.skipped[0]?.message || '没有同时满足形态、市值、板块和买点的标的' });
  for (const row of prepared.buys) {
    if (opened >= policy.maxNewOpens || held.size >= policy.maxPositions) break;
    if (held.has(row.symbol)) continue;
    const quote = quoteMap.get(row.symbol);
    const last = quote?.ok ? quote.last : row.price;
    if (!(last > 0)) {
      session.skipped.push({ symbol: row.symbol, reason: 'quote-unavailable', message: '没有报价' });
      continue;
    }
    const sized = sizeLimitPullback({ nav, cash, price: last, lot: prepared.lot, positions: held.size });
    if (!sized) {
      session.skipped.push({ symbol: row.symbol, reason: 'size', message: '现金或整手不够，预留 10%' });
      continue;
    }
    const out = await placePaperOrder({
      desk: id,
      id: `paper-auto:${day}:${id}:${row.symbol}:buy`,
      symbol: row.symbol,
      side: 'buy',
      qty: sized.qty,
      limitPrice: last * 1.002,
      stopPrice: sized.stop,
      maxLoss: sized.maxLoss,
      instrument: 'equity',
      paperReference: id === '0g' || paperEquityNeedsReference(quote),
      theme: row.list || '',
      note: `paper-auto-xiaomeng:${row.shape}:${row.boards}`,
      strategy: { stage: 'limit-pullback', stageLabel: row.shape === 'ladder' ? '阶梯回调' : '震荡回调', score: row.boards }
    });
    (out.ok ? session.fills : session.skipped).push(out);
    if (out.ok && !out.replay) {
      cash -= out.price * out.qty;
      opened += 1;
      held.add(row.symbol);
    }
  }
  return finish(id, session, await loadPaperLedger(id));
}

/** 先 0A 质量，再 0B 进攻，再 0C。0D 算卦、0E 期权、0F 动量、0G/0H 小孟另账，不占用前三本的标的名额。 */
export async function runPaperOpen({ date, recs, force = false, desk } = {}) {
  const config = await readAutoConfig();
  const want = desksWanted(desk, config);
  const stops = {};
  for (const id of want) {
    if (id === '0e') continue;
    try { stops[id] = await sweepPaperStops(id, id === '0g' ? { loader: chinaStopLoader } : {}); }
    catch (error) { stops[id] = { ok: false, desk: id, fills: [], error: error.message }; }
  }
  if (!regularPaperSession()) {
    return {
      ok: true,
      liveTrading: false,
      auto: true,
      outsideSession: true,
      date: date || todayStamp(),
      sessions: {},
      stops,
      note: '非美股常规交易时段：只按日线最低价回放券商止损，不开新仓、不做主观卖出。开盘后（美东 9:30–16:00）再跑才会下自动单。'
    };
  }
  const mainHeld = await liveAccountSymbols('main');
  const tacticalHeld = await liveAccountSymbols('tactical');
  const existing0a = await paperSymbols('0a');
  const existing0b = await paperSymbols('0b');
  const existing0c = await paperSymbols('0c');
  const sessions = {};

  if (want.includes('0a')) {
    const blocked = new Set([...mainHeld, ...existing0b, ...existing0c]);
    sessions['0a'] = await runPaperSession({ date, recs, desk: '0a', force, blockedSymbols: blocked });
  }
  const opened0a = openedBuys(sessions['0a']);
  if (want.includes('0b')) {
    const blocked = new Set([...mainHeld, ...tacticalHeld, ...existing0a, ...opened0a, ...existing0c]);
    sessions['0b'] = await runPaperSession({ date, recs, desk: '0b', force, blockedSymbols: blocked });
  }
  const opened0b = openedBuys(sessions['0b']);
  if (want.includes('0c')) {
    const blocked = new Set([...existing0a, ...opened0a, ...existing0b, ...opened0b]);
    sessions['0c'] = await runPaperSession({ date, recs, desk: '0c', force, blockedSymbols: blocked });
  }
  if (want.includes('0d')) {
    try { sessions['0d'] = await runOracleSession({ date, force }); }
    catch (error) { sessions['0d'] = { ok: false, desk: '0d', fills: [], skipped: [{ message: error.message }], note: error.message }; }
  }
  if (want.includes('0e')) {
    try { sessions['0e'] = await runOptionSession({ date, force }); }
    catch (error) { sessions['0e'] = { ok: false, desk: '0e', fills: [], skipped: [{ message: error.message }], note: error.message }; }
  }
  if (want.includes('0f')) {
    try { sessions['0f'] = await runMomentumSession({ date, force }); }
    catch (error) { sessions['0f'] = { ok: false, desk: '0f', fills: [], skipped: [{ message: error.message }], note: error.message }; }
  }
  if (want.includes('0g')) {
    try { sessions['0g'] = await runXiaomengSession({ date, force, desk: '0g' }); }
    catch (error) { sessions['0g'] = { ok: false, desk: '0g', fills: [], skipped: [{ message: error.message }], note: error.message }; }
  }
  if (want.includes('0h')) {
    try { sessions['0h'] = await runXiaomengSession({ date, force, desk: '0h' }); }
    catch (error) { sessions['0h'] = { ok: false, desk: '0h', fills: [], skipped: [{ message: error.message }], note: error.message }; }
  }

  return {
    ok: Object.values(sessions).every((session) => session.ok !== false && !session.recordingError),
    liveTrading: false,
    auto: true,
    date: date || todayStamp(),
    sessions,
    stops,
    note: '0A 财富 + 0B 进攻 + 0C Agentic，然后 0D 算卦、0E 只处理已有期权、0F Claude 动量、0G 小孟A股、0H 小孟美股。后面几本不占用前三本标的。不是实盘。'
  };
}

async function finish(desk, session, ledger) {
  const next = await recordPaperSession(desk, {
      date: session.date,
      at: new Date().toISOString(),
      mode: session.mode,
      style: session.style,
      fillCount: session.fills.length,
      skipCount: session.skipped.length,
      sources: session.sources || null,
      skips: (session.skipped || []).slice(0, 8).map((row) => ({
        symbol: row.symbol || null,
        reason: row.reason || null,
        message: row.message || null
      })),
      reviews: session.reviews || []
  });
  await appendAudit({
    type: 'proposal',
    desk,
    date: session.date,
    fillCount: session.fills.length,
    skipCount: session.skipped.length,
    items: [
      ...(session.fills || []).map((row) => ({ symbol: row.symbol || null, proposal: row.side || null, result: row.ok ? 'fill' : 'rejected', reason: row.reason || null, message: row.message || null })),
      ...(session.skipped || []).slice(0, 12).map((row) => ({ symbol: row.symbol || null, proposal: row.side || 'skip', result: 'skip', reason: row.reason || null, message: row.message || null })),
      ...(session.reviews || []).filter((row) => row.action && row.action !== 'HOLD').map((row) => ({ symbol: row.symbol || null, proposal: row.action, result: 'review', reason: row.reason || null, message: row.label || null }))
    ]
  }).catch(() => {});
  if (next.ok === false) { session.ok = false; session.recordingError = next.decision?.message; return session; }
  session.nav = next.nav;
  session.cash = next.cash;
  session.positions = (next.positions || []).length;
  return session;
}
