import { mkdir, readFile, writeFile, rename, rmdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, OBSIDIAN_PAPER, isUsSessionDay, lastSessionStamp, recsDir, todayStamp } from '../paths.js';
import { sessionClosed, sessionOpenMs } from '../market-time.js';
import { loadQuotes } from '../quotes.js';
import { loadLimits, PAPER_DESKS, paperDeskOf } from '../risk/limits.js';
import { checkOrder } from '../risk/service.js';
import { bookState, loadRiskState, touchBook } from '../risk/state.js';
import { orderNotional, findPosition } from '../risk/gateway.js';
import { finiteNumber as num, instrumentOf } from '../numbers.js';
import { brokerStopHit, orderFingerprint, paperExecution } from './execution.js';
import { loadHistoricals } from '../historicals.js';
import { sameOptionContract } from './signals.js';
import { loadExpirationChain, loadOptionChain } from '../options/market.js';
import { evaluateFreshness } from '../risk/freshness.js';
import { resolveMode } from '../risk/mode.js';
import { DESK_POLICY, exitLabel, exitPlan } from './policy.js';

export function paperPath(desk = '0b') {
  return join(DATA_DIR, 'paper', `${paperDeskOf(desk)}.json`);
}

function seedLedger(desk) {
  const meta = PAPER_DESKS[paperDeskOf(desk)];
  const seed = meta.seed;
  return {
    id: `paper-${meta.id}`,
    type: 'paper-experiment',
    desk: meta.id,
    seed,
    cash: seed,
    positions: [],
    fills: [],
    nav: seed,
    peakNav: seed,
    asOf: null,
    note: `${meta.label}。独立纸上实验，不写推荐 / 模拟 / 实际操作，不用 Grok 实盘快照做 Day0。`
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadPaperLedger(desk = '0b') {
  const id = paperDeskOf(desk);
  const limits = await loadLimits(`paper-${id}`);
  let raw = await readJson(paperPath(id));
  if (!raw) {
    const seed = limits.seed ?? PAPER_DESKS[id].seed;
    return { ...seedLedger(id), seed, cash: seed, nav: seed, peakNav: seed };
  }
  return {
    ...seedLedger(id),
    ...raw,
    desk: id,
    positions: raw.positions || [],
    fills: raw.fills || []
  };
}

export async function savePaperLedger(ledger) {
  const id = paperDeskOf(ledger.desk || ledger.id);
  await mkdir(join(DATA_DIR, 'paper'), { recursive: true });
  const next = { ...ledger, desk: id, updatedAt: new Date().toISOString() };
  const temp = `${paperPath(id)}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, paperPath(id));
  return next;
}

function markNav(ledger) {
  const stock = (ledger.positions || []).reduce((sum, row) => {
    const qty = Number(row.qty) || 0;
    const px = Number(row.last ?? row.avgCost) || 0;
    const mult = String(row.instrument || 'equity') === 'option' ? 100 : 1;
    const value = row.marketValue != null ? Number(row.marketValue) : qty * px * mult;
    return sum + value;
  }, 0);
  const cash = Number(ledger.cash) || 0;
  const nav = cash + stock;
  return { ...ledger, nav, peakNav: Math.max(Number(ledger.peakNav) || 0, nav) };
}

let optionChainLoader = (symbol, expirationUnix, opts) => loadOptionChain(symbol, expirationUnix, opts || {});

/** Tests inject a chain so a paper view does not hit the network. */
export function setPaperOptionChainLoader(loader) {
  optionChainLoader = loader || ((symbol, expirationUnix, opts) => loadOptionChain(symbol, expirationUnix, opts || {}));
}

async function loadChainForExpiration(symbol, expiration) {
  return loadExpirationChain(symbol, expiration, {
    loader: (sym, unix, opts) => optionChainLoader(sym, unix, opts)
  });
}

/** Bid/ask for the contract actually held. Ignores caller-supplied prices. */
export async function quoteHeldOption(pos) {
  const symbol = String(pos?.symbol || '').toUpperCase();
  const expiration = pos?.expiration;
  if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(String(expiration || ''))) return null;
  let chain = null;
  try {
    chain = await loadChainForExpiration(symbol, expiration);
  } catch {
    return null;
  }
  const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
  const wanted = {
    symbol,
    expiration,
    strike: pos.strike,
    optionType: pos.optionType || pos.right || pos.type
  };
  const hit = legs.find((leg) => sameOptionContract(wanted, { ...leg, symbol }));
  if (!hit) return null;
  return {
    bid: num(hit.bid),
    ask: num(hit.ask),
    last: num(hit.last),
    quoteAt: num(hit.quoteAt),
    quoteMode: hit.quoteMode || null,
    standard: hit.standard,
    multiplier: hit.multiplier,
    lastTradeAt: num(hit.lastTradeAt),
    type: hit.type,
    expiration: hit.expiration || expiration,
    strike: num(hit.strike)
  };
}

async function refreshOptionMarks(ledger) {
  const groups = new Map();
  for (const pos of ledger.positions || []) {
    if (instrumentOf(pos.instrument) !== 'option') continue;
    const key = `${String(pos.symbol || '').toUpperCase()}|${pos.expiration || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pos);
  }
  const jobs = [...groups.entries()];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const [key, rows] = jobs[index];
      const [symbol, expiration] = key.split('|');
      let chain = null;
      try {
        chain = await loadChainForExpiration(symbol, expiration);
      } catch {
        chain = null;
      }
      const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
      for (const pos of rows) {
        const hit = legs.find((leg) => sameOptionContract(pos, { ...leg, symbol }));
        const bid = Number(hit?.bid);
        const ask = Number(hit?.ask);
        const lastTrade = Number(hit?.last);
        let price = null;
        if (bid > 0 && ask >= bid) {
          price = (bid + ask) / 2;
          pos.markKind = 'mid';
          pos.markedAt = new Date().toISOString();
        } else if (lastTrade > 0) {
          price = lastTrade;
          pos.markKind = 'last';
          const tradedAt = Number(hit?.lastTradeAt);
          pos.markedAt = Number.isFinite(tradedAt) && tradedAt > 0 ? new Date(tradedAt).toISOString() : null;
        }
        if (!(price > 0)) continue;
        pos.last = Number(price.toFixed(4));
        pos.marketValue = Number((pos.qty * pos.last * 100).toFixed(2));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
}

async function markQuotes(ledger) {
  await refreshOptionMarks(ledger);
  const equities = ledger.positions.filter((pos) => instrumentOf(pos.instrument) === 'equity');
  const quotes = await loadQuotes(equities.map((pos) => pos.symbol));
  let valuationFresh = true;
  for (const pos of ledger.positions) {
    if (instrumentOf(pos.instrument) === 'option') {
      const px = Number(pos.last ?? pos.avgCost) || 0;
      pos.marketValue = Number((pos.qty * px * 100).toFixed(2));
      if (!(Date.now() - Date.parse(pos.markedAt || 0) <= 180_000)) valuationFresh = false;
      continue;
    }
    const quote = quotes[pos.symbol];
    if (quote?.ok && quote.last > 0) {
      pos.last = quote.last;
      pos.marketValue = pos.qty * quote.last;
      pos.quoteAt = quote.quoteAt;
    }
    if (!quote?.ok || !evaluateFreshness({ quoteAt: quote?.quoteAt, last: quote?.last }).fresh) valuationFresh = false;
  }
  return { ...markNav(ledger), valuationFresh };
}

export async function paperBookSnapshot(state, desk = '0b') {
  const id = paperDeskOf(desk);
  const ledger = await markQuotes(await loadPaperLedger(id));
  const risk = state || await loadRiskState();
  const slice = bookState(risk, id);
  const peak = Math.max(Number(slice.peakNav) || 0, Number(ledger.peakNav) || 0);
  return {
    book: `paper-${id}`,
    accountId: `paper-${id}`,
    desk: id,
    nav: ledger.nav,
    cash: ledger.cash,
    buyingPower: ledger.cash,
    peakNav: peak,
    positions: ledger.positions,
    realizedPnlToday: paperDayPnl(ledger, todayStamp()),
    realizedPnlWeek: Number(slice.pnlWeek) || 0,
    mode: slice.mode,
    modeReason: slice.reason,
    kill: slice.mode === 'KILL',
    killReason: slice.reason,
    holdingsFresh: ledger.valuationFresh,
    asOf: ledger.asOf,
    stale: !ledger.valuationFresh
  };
}

function paperDayPnl(ledger, date) {
  return (ledger.fills || [])
    .filter((row) => String(row.date || '').slice(0, 10) === date)
    .reduce((sum, row) => sum + Number(row.realizedPnl || 0), 0);
}

function upsertPosition(positions, fill) {
  const next = [...positions];
  const idx = next.findIndex((row) => (
    row.symbol === fill.symbol
    && instrumentOf(row.instrument) === fill.instrument
    && (fill.instrument !== 'option' || sameOptionContract(row, fill))
  ));
  const signed = fill.side === 'sell' || fill.side === 'trim' || fill.side === 'exit' || fill.side === 'close'
    ? -Math.abs(fill.qty)
    : Math.abs(fill.qty);
  if (idx < 0) {
    if (signed <= 0) return next;
    next.push({
      symbol: fill.symbol,
      instrument: fill.instrument,
      qty: signed,
      avgCost: fill.price,
      last: fill.price,
      marketValue: signed * fill.price * (fill.instrument === 'option' ? 100 : 1),
      stopPrice: fill.stopPrice,
      entryStop: fill.stopPrice ?? null,
      riskPer: fill.price != null && fill.stopPrice != null ? Math.abs(fill.price - fill.stopPrice) : null,
      maxLoss: fill.maxLoss ?? null,
      theme: fill.theme || '',
      expiration: fill.expiration || null,
      strike: fill.strike ?? null,
      optionType: fill.optionType || null,
      strategy: fill.strategy || null
    });
    return next;
  }
  const cur = next[idx];
  const newQty = Number(cur.qty) + signed;
  if (Math.abs(newQty) < 1e-9) {
    next.splice(idx, 1);
    return next;
  }
  if (signed > 0) {
    const cost = Number(cur.avgCost) * Number(cur.qty) + fill.price * signed;
    cur.avgCost = cost / newQty;
  }
  cur.qty = newQty;
  cur.last = fill.price;
  cur.marketValue = newQty * fill.price * (fill.instrument === 'option' ? 100 : 1);
  if (fill.stopPrice) {
    if (Number(cur.stopPrice) !== Number(fill.stopPrice) && fill.date && (!cur.stopCheckedThrough || cur.stopCheckedThrough < fill.date)) {
      cur.stopCheckedThrough = fill.date;
    }
    cur.stopPrice = fill.stopPrice;
  }
  cur.maxLoss = cur.stopPrice > 0 ? Math.abs(newQty) * Math.abs(cur.avgCost - cur.stopPrice) * (fill.instrument === 'option' ? 100 : 1) : null;
  if (cur.entryStop == null && fill.stopPrice) cur.entryStop = fill.stopPrice;
  if (cur.riskPer == null && fill.price != null && fill.stopPrice != null) {
    cur.riskPer = Math.abs(fill.price - fill.stopPrice);
  }
  return next;
}

function realizedOnClose(pos, fill) {
  if (!pos) return 0;
  const closing = fill.side === 'sell' || fill.side === 'trim' || fill.side === 'exit' || fill.side === 'close';
  if (!closing) return 0;
  const qty = Math.min(Math.abs(fill.qty), Math.abs(Number(pos.qty) || 0));
  const mult = fill.instrument === 'option' ? 100 : 1;
  return (fill.price - Number(pos.avgCost || fill.price)) * qty * mult;
}

async function writePaperDay(ledger, date) {
  if (!OBSIDIAN_PAPER) return null;
  await mkdir(OBSIDIAN_PAPER, { recursive: true });
  const dayFills = (ledger.fills || []).filter((row) => row.date === date);
  const desk = paperDeskOf(ledger.desk);
  const stem = `${date}-${desk}`;
  const pack = {
    type: 'paper-experiment',
    liveTrading: false,
    date,
    desk,
    generatedAt: new Date().toISOString(),
    id: ledger.id,
    cash: ledger.cash,
    nav: ledger.nav,
    peakNav: ledger.peakNav,
    positions: ledger.positions,
    fills: dayFills,
    note: '独立纸上实验。不是模拟操作，不是下单指令。'
  };
  await writeFile(join(OBSIDIAN_PAPER, `${stem}.json`), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  const posRows = (ledger.positions || []).map((row) => (
    `| ${row.symbol} | ${row.instrument} | ${row.qty} | ${Number(row.avgCost).toFixed(2)} | ${Number(row.last).toFixed(2)} | ${row.stopPrice ?? '—'} | ${row.strategy?.stageLabel || row.strategy?.stage || '—'} |`
  )).join('\n');
  const fillRows = dayFills.map((row) => (
    `| ${row.date || ''} ${row.time || ''} | ${row.side} | ${row.symbol} | ${row.qty} | ${Number(row.price).toFixed(2)} | ${row.stopPrice ?? '—'} | ${row.strategy?.stageLabel || row.strategy?.stage || ''} ${row.note || ''} |`
  )).join('\n');
  const md = `---
title: 纸上实验
date: ${date}
desk: ${desk}
type: paper-experiment
liveTrading: false
---

# ${date} 纸上实验（${PAPER_DESKS[desk].label}）

> 独立账本，不进推荐 / 模拟 / 实际操作。缺文件不让每日任务失败。
> 现金 $${Number(ledger.cash).toFixed(2)} · 净值 $${Number(ledger.nav).toFixed(2)}

## 当日成交

| 成交时间 | 方向 | 代码 | 数量 | 价格 | 止损 | 备注 |
| --- | --- | --- | ---: | ---: | ---: | --- |
${fillRows || '| — |  |  |  |  |  | 今日无成交 |'}

## 纸上持仓

| 代码 | 品种 | 数量 | 成本 | 现价 | 止损 | 策略 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${posRows || '| — | 空仓 |  |  |  |  |  |'}
`;
  await writeFile(join(OBSIDIAN_PAPER, `${stem}.md`), `${md}\n`, 'utf8');
  return { dir: OBSIDIAN_PAPER, date, desk, file: stem };
}

async function withPaperLock(task) {
  const lock = join(DATA_DIR, 'paper', '.execution-lock');
  await mkdir(join(DATA_DIR, 'paper'), { recursive: true });
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { ok: false, liveTrading: false, decision: { ok: false, code: 'paper-busy', message: '另一笔纸上账本操作正在执行；请稍后重试' } };
  }
  try { return await task(); } finally { await rmdir(lock); }
}

export async function placePaperOrder(raw = {}) {
  return withPaperLock(() => placePaperOrderLocked(raw));
}

function lastClosedSession(now = new Date()) {
  const today = todayStamp(now);
  if (isUsSessionDay(today) && sessionClosed(today, now)) return today;
  return lastSessionStamp(new Date(new Date(`${today}T12:00:00-05:00`).getTime() - 86400000));
}

/**
 * Only the stop level in force on a bar may be replayed against it. Stops that moved without a
 * known date are checked forward from the last closed session, never back-filled.
 */
export function stopReplayStart(pos, fills, closed) {
  if (pos.stopCheckedThrough) return pos.stopCheckedThrough;
  const buys = (fills || []).filter((f) => f.symbol === pos.symbol && instrumentOf(f.instrument) === 'equity' && ['buy', 'add'].includes(f.side));
  const entry = [...buys].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
  const entryStop = num(entry?.stopPrice);
  if (!entry?.date || pos.trailedAt || entryStop == null || Math.abs(entryStop - Number(pos.stopPrice)) > 1e-6) return closed;
  const later = (fills || []).filter((f) => f !== entry && f.symbol === pos.symbol && instrumentOf(f.instrument) === 'equity' && String(f.date) >= entry.date);
  const stopMoved = later.some((f) => num(f.stopPrice) != null && Math.abs(num(f.stopPrice) - entryStop) > 1e-6);
  return stopMoved ? closed : entry.date;
}

/** 券商侧止损回放：日线最低价碰到止损就按 min(止损, 开盘) 成交。只在内部调用，不经 HTTP。 */
export async function sweepPaperStops(desk, { loader = loadHistoricals, through = todayStamp(), now = new Date() } = {}) {
  return withPaperLock(async () => {
    const id = paperDeskOf(desk);
    const ledger = await loadPaperLedger(id);
    const closed = lastClosedSession(now);
    const fills = [];
    const checked = [];
    const advanced = new Map();
    for (const pos of ledger.positions || []) {
      if (instrumentOf(pos.instrument) !== 'equity' || !(Number(pos.stopPrice) > 0) || !(Number(pos.qty) > 0)) continue;
      const after = stopReplayStart(pos, ledger.fills, closed);
      const hist = await loader(pos.symbol);
      const hit = hist?.ok ? brokerStopHit(hist.bars, pos.stopPrice, after, through) : null;
      checked.push({ symbol: pos.symbol, stop: Number(pos.stopPrice), after, hit: hit?.date || null, data: Boolean(hist?.ok) });
      if (!hit) {
        if (hist?.ok) advanced.set(pos.symbol, after > closed ? after : closed);
        continue;
      }
      const gap = hit.open > 0 && hit.open <= hit.stop;
      const filledAt = new Date(sessionOpenMs(hit.date) + (gap ? 0 : 6.5 * 3600000)).toISOString();
      const execution = {
        ok: true, price: hit.price, referencePrice: hit.reference, slippageBps: 5, fee: 0, quoteAt: null,
        model: 'paper-broker-stop-v1', barDate: hit.date,
        feeNote: `券商侧止损回放：${hit.date} 最低 ${hit.low} ≤ 止损 ${hit.stop}，${gap ? '跳空低开按开盘' : '按止损价'}成交（日线无法定位盘中时刻，记 ${gap ? '9:30' : '16:00'} ET）`
      };
      const out = await placePaperOrderLocked({
        desk: id,
        id: `paper-stop:${id}:${pos.symbol}:${hit.date}`,
        symbol: pos.symbol,
        side: 'sell',
        qty: Number(pos.qty),
        limitPrice: hit.price,
        stopPrice: pos.stopPrice,
        maxLoss: pos.maxLoss,
        instrument: 'equity',
        reduceOnly: true,
        note: 'paper-broker-stop'
      }, { execution, date: hit.date, time: filledAt });
      fills.push(out.ok
        ? { ok: true, symbol: pos.symbol, date: hit.date, price: hit.price, qty: Number(pos.qty), replay: Boolean(out.replay) }
        : { ok: false, symbol: pos.symbol, date: hit.date, message: out.decision?.message || 'Gateway 拒绝' });
    }
    if (advanced.size) {
      const latest = await loadPaperLedger(id);
      let changed = false;
      for (const pos of latest.positions || []) {
        const next = advanced.get(pos.symbol);
        if (next && instrumentOf(pos.instrument) === 'equity' && pos.stopCheckedThrough !== next) {
          pos.stopCheckedThrough = next;
          changed = true;
        }
      }
      if (changed) await savePaperLedger(latest);
    }
    return { ok: true, desk: id, closed, checked, fills };
  });
}

async function placePaperOrderLocked(raw = {}, internal = {}) {
  const desk = paperDeskOf(raw.desk || raw.book);
  const quoteSymbol = String(raw.symbol || '').toUpperCase();
  raw = { ...raw, symbol: quoteSymbol, side: String(raw.side || '').toLowerCase(), instrument: instrumentOf(raw.instrument) };
  const id = String(raw.id || raw.clientOrderId || raw.signal_id || '').trim() || randomUUID();
  const fingerprint = orderFingerprint(raw);
  const ledger = await markQuotes(await loadPaperLedger(desk));
  const previous = ledger.fills.find((fill) => fill.id === id);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return { ok: false, liveTrading: false, decision: { ok: false, code: 'id-conflict', message: '此订单 ID 已成交，参数不同或属于旧版记录，不得复用' } };
    return { ok: true, liveTrading: false, replay: true, desk, fill: previous, ledger };
  }
  const isOption = raw.instrument === 'option';
  const reducing = ['sell', 'trim', 'exit', 'close'].includes(raw.side);
  let trustedLeg = null;
  if (isOption && reducing) {
    const live = await quoteHeldOption(raw);
    if (live && live.bid > 0 && live.ask >= live.bid && live.standard !== false && (live.multiplier == null || Number(live.multiplier) === 100)) {
      trustedLeg = live;
    }
  }
  if (isOption && !(num(trustedLeg?.bid) > 0 && num(trustedLeg?.ask) >= num(trustedLeg?.bid))) {
    const { loadOptionsFile } = await import('../options/engine.js');
    const day = todayStamp();
    const pack = await loadOptionsFile(day, 'cov');
    if (pack?.date === day && !pack.stale) {
      trustedLeg = (pack.ideas || [])
        .flatMap((row) => (row.contract?.legs || []).map((leg) => ({ ...leg, symbol: row.symbol })))
        .find((leg) => sameOptionContract(raw, leg) && leg.standard !== false && (leg.multiplier == null || Number(leg.multiplier) === 100)) || null;
    }
  }
  if (isOption && reducing && trustedLeg && !(num(trustedLeg.quoteAt) > 0)) {
    raw = { ...raw, paperReference: true };
  }
  const quotes = isOption ? {} : await loadQuotes([quoteSymbol]);
  const quote = isOption
    ? {
      ok: num(trustedLeg?.bid) > 0 && num(trustedLeg?.ask) > 0 && num(trustedLeg?.ask) >= num(trustedLeg?.bid),
      bid: num(trustedLeg?.bid),
      ask: num(trustedLeg?.ask),
      last: num(trustedLeg?.ask),
      quoteAt: num(trustedLeg?.quoteAt),
      quoteMode: trustedLeg?.quoteMode || null
    }
    : quotes[quoteSymbol];
  const last = quote?.ok ? quote.last : null;
  const order = {
    ...raw,
    id,
    book: `paper-${desk}`,
    desk,
    accountId: `paper-${desk}`,
    last,
    quoteMode: isOption ? quote.quoteMode : raw.quoteMode,
    limitPrice: raw.limitPrice ?? raw.price ?? last,
    inputs: {
      ...(raw.inputs || {}),
      last,
      quoteAt: quote?.quoteAt ?? null,
      hasQuote: last != null,
      hasIntra: false,
      hasChain: isOption ? Boolean(quote?.quoteAt) : true,
      chainAt: isOption ? (quote?.quoteAt ?? null) : null
    }
  };
  const execution = internal.execution || paperExecution(order, quote);
  if (!execution.ok) return { ok: false, liveTrading: false, desk, decision: execution };
  const checked = await checkOrder(order);
  if (!checked.decision.ok) {
    return { ok: false, liveTrading: false, decision: checked.decision, book: checked.book, desk };
  }

  const price = execution.price;
  const qty = Number(order.qty);
  const side = String(order.side).toLowerCase();
  const instrument = String(order.instrument || 'equity').toLowerCase();
  const date = internal.date || todayStamp();
  const pos = findPosition(ledger.positions, order);
  const fill = {
    id: checked.decision.id,
    fingerprint,
    execution,
    date,
    time: internal.time || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    symbol: order.symbol,
    side,
    instrument,
    qty,
    price,
    stopPrice: order.stopPrice ?? null,
    maxLoss: checked.decision.risk,
    theme: order.theme || '',
    expiration: order.expiration || null,
    strike: order.strike ?? null,
    optionType: order.optionType || null,
    realizedPnl: realizedOnClose(pos, { ...order, price, qty, side, instrument }),
    note: raw.note || 'paper',
    strategy: raw.strategy || null
  };
  const notional = orderNotional({ ...order, limitPrice: price }) || 0;
  if (side === 'buy' || side === 'add') ledger.cash -= notional;
  else ledger.cash += notional;
  ledger.positions = upsertPosition(ledger.positions, fill);
  ledger.fills = [...(ledger.fills || []), fill];
  ledger.asOf = fill.recordedAt;
  const marked = markNav(ledger);
  await savePaperLedger(marked);

  const state = await loadRiskState();
  const slice = bookState(state, desk);
  const today = todayStamp();
  const pnlDay = paperDayPnl(marked, today);
  await touchBook(state, desk, {
    peakNav: Math.max(Number(slice.peakNav) || 0, marked.peakNav || 0),
    pnlDay,
    pnlWeek: (Number(slice.pnlWeek) || 0) + (date === today ? Number(fill.realizedPnl || 0) : 0)
  });
  const written = await writePaperDay(marked, date);
  return {
    ok: true,
    liveTrading: false,
    draft: true,
    desk,
    decision: checked.decision,
    fill,
    ledger: marked,
    written
  };
}

export async function trailPaperStop(desk, symbol, stopPrice) {
  return withPaperLock(() => trailPaperStopLocked(desk, symbol, stopPrice));
}

async function trailPaperStopLocked(desk, symbol, stopPrice) {
  const id = paperDeskOf(desk);
  const ledger = markNav(await loadPaperLedger(id));
  const pos = (ledger.positions || []).find((row) => row.symbol === symbol);
  const nextStop = Number(stopPrice);
  const cur = Number(pos?.stopPrice);
  if (!pos || !Number.isFinite(nextStop) || (Number.isFinite(cur) && nextStop <= cur + 1e-6)) {
    return { ok: false, ledger };
  }
  pos.stopPrice = nextStop;
  pos.maxLoss = null;
  pos.trailedAt = new Date().toISOString();
  const today = todayStamp();
  if (!pos.stopCheckedThrough || pos.stopCheckedThrough < today) pos.stopCheckedThrough = today;
  const marked = markNav(ledger);
  await savePaperLedger(marked);
  return { ok: true, desk: id, symbol, stopPrice: nextStop, ledger: marked };
}

/** 期权按扫描 Bid/Ask 中间价盯市；没有这张合约报价的仓位保持原值。 */
export async function markPaperOptions(desk, marks = []) {
  return withPaperLock(async () => {
    const id = paperDeskOf(desk);
    const ledger = await loadPaperLedger(id);
    let changed = 0;
    for (const pos of ledger.positions || []) {
      if (instrumentOf(pos.instrument) !== 'option') continue;
      const hit = marks.find((row) => sameOptionContract(pos, row));
      const bid = Number(hit?.bid), ask = Number(hit?.ask);
      if (!(bid > 0) || !(ask >= bid)) continue;
      pos.last = Number(((bid + ask) / 2).toFixed(4));
      pos.marketValue = pos.qty * pos.last * 100;
      pos.markedAt = new Date().toISOString();
      changed += 1;
    }
    if (!changed) return { ok: true, changed, ledger };
    const marked = markNav(ledger);
    await savePaperLedger(marked);
    return { ok: true, changed, ledger: marked };
  });
}

export async function resetPaper(desk = '0b') {
  return withPaperLock(() => resetPaperLocked(desk));
}

async function resetPaperLocked(desk) {
  const id = paperDeskOf(desk);
  const next = { ...seedLedger(id), asOf: new Date().toISOString() };
  await savePaperLedger(next);
  const state = await loadRiskState();
  await touchBook(state, id, {
    peakNav: next.seed,
    pnlDay: 0,
    pnlWeek: 0,
    rejectCount: 0
  });
  return next;
}

async function latestRecIndex() {
  const dir = recsDir('grok');
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return { date: null, byKey: {} };
  }
  const date = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .at(-1) || null;
  if (!date) return { date: null, byKey: {} };
  const json = await readJson(join(dir, `${date}.json`));
  const byKey = {};
  for (const book of json?.accounts || []) {
    for (const row of book.recommendations || []) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (symbol) byKey[`${book.id}:${symbol}`] = row;
    }
  }
  return { date, byKey };
}

function positionExits(ledger, deskId, recs) {
  if (deskId === '0d' || deskId === '0e' || deskId === '0f' || deskId === '0g' || deskId === '0h') {
    return (ledger.positions || []).map((pos) => {
      const review = (ledger.lastAuto?.reviews || []).find((row) => deskId === '0e'
        ? sameOptionContract(pos, row)
        : row.symbol === pos.symbol);
      return {
        symbol: pos.symbol,
        expiration: pos.expiration || null,
        strike: pos.strike ?? null,
        optionType: pos.optionType || null,
        action: review?.action || 'REVIEW',
        label: review ? `${ledger.lastAuto.date}：${review.label}` : '尚无本策略的卖出判断'
      };
    });
  }
  const policy = DESK_POLICY[deskId] || DESK_POLICY['0b'];
  const recId = policy.recId || 'agentic';
  return (ledger.positions || []).map((pos) => {
    const symbol = String(pos.symbol || '').toUpperCase();
    const plan = exitPlan(pos, pos.last, recs.byKey[`${recId}:${symbol}`] || null, policy);
    return {
      symbol,
      action: plan.action,
      reason: plan.reason,
      qty: plan.qty,
      trail: plan.trail,
      label: exitLabel(plan)
    };
  });
}

export async function getPaperView(desk = '0b') {
  const id = paperDeskOf(desk);
  const ledger = await markQuotes(await loadPaperLedger(id));
  const state = await loadRiskState();
  const book = await paperBookSnapshot(state, id);
  const limits = await loadLimits(`paper-${id}`);
  const mode = resolveMode(book, { ...limits, caps: (await import('../risk/limits.js')).resolveCaps(book.nav, limits) }, bookState(state, id));
  const recs = await latestRecIndex();
  return {
    ok: true,
    liveTrading: false,
    type: 'paper-experiment',
    date: todayStamp(),
    desk: id,
    desks: PAPER_DESKS,
    ledger,
    lastAuto: ledger.lastAuto || null,
    exits: positionExits(ledger, id, recs),
    recDate: recs.date,
    book,
    mode: mode.mode,
    modeReason: mode.reason,
    kill: mode.mode === 'KILL',
    killReason: mode.reason,
    note: ledger.note
  };
}

export async function listPaperViews() {
  const out = {};
  for (const id of Object.keys(PAPER_DESKS)) {
    out[id] = await getPaperView(id);
  }
  return out;
}

export async function recordPaperSession(desk, lastAuto) {
  return withPaperLock(async () => {
    const ledger = await loadPaperLedger(desk);
    return savePaperLedger({ ...ledger, lastAuto });
  });
}
