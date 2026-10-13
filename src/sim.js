import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPORTS_DIR, SIM_DIR, recsDir, recsLegacyDir, simVaultDir, todayStamp as nyDate, lastSessionStamp, isUsSessionDay } from './paths.js';
import { deskById, loadConfig, loadHoldings } from './holdings.js';
import { loadManyHistoricals } from './historicals.js';
import { historicalExecution } from './sim-execution.js';
import { buildCard, nextSessionStamp, sizeBuild } from './sim-build.js';
import { sessionClosed } from './market-time.js';
import { instrumentOf } from './numbers.js';
import { loadChatgptFreshness } from './sim-freshness.js';

export const SIM_BOOKS = ['sim-grok', 'sim-chatgpt'];
export const DEFAULT_CAPITAL = { main: null, tactical: 20_000, agentic: 5_000 };
const ACCOUNT_IDS = ['main', 'tactical', 'agentic'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function roundQty(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function todayStamp(date = new Date()) {
  return nyDate(date);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isPlaceholder(symbol) {
  const sym = String(symbol || '').toUpperCase();
  return !sym || sym === '—' || /ZZZ$/.test(sym);
}

function avgCostOf(row) {
  if (row.avgCost != null && Number.isFinite(Number(row.avgCost))) return Number(row.avgCost);
  const qty = Number(row.qty);
  if (row.cost != null && qty > 0) return Number(row.cost) / qty;
  if (row.last != null) return Number(row.last);
  return 0;
}

function clonePositions(positions) {
  return (positions || []).filter((row) => !isPlaceholder(row.symbol) && Number(row.qty) > 0).map((row) => {
    const qty = Number(row.qty);
    const avgCost = avgCostOf(row);
    const last = row.last != null ? Number(row.last) : avgCost;
    return {
      symbol: String(row.symbol).toUpperCase(),
      name: row.name || row.symbol,
      qty,
      role: row.role || '',
      theme: row.theme || '',
      avgCost: round2(avgCost),
      last: last ? round2(last) : null,
      changePct: row.changePct ?? null,
      marketValue: round2(qty * (last || avgCost || 0))
    };
  });
}

function markBook(book, quotes = {}) {
  let market = 0;
  for (const pos of book.positions) {
    const quote = quotes[pos.symbol];
    if (quote?.ok && quote.last != null) {
      pos.last = quote.last;
      pos.changePct = quote.changePct ?? null;
    }
    const px = pos.last ?? pos.avgCost ?? 0;
    pos.marketValue = round2(pos.qty * px);
    market += pos.marketValue;
  }
  book.marketValue = round2(market);
  book.equity = round2(Number(book.cash || 0) + market);
  book.positionCount = book.positions.length;
  book.pnl = round2(book.equity - Number(book.startingNav || 0));
  const configured = Number(book.startingNav) > 0;
  book.pnlPct = configured ? round2((book.pnl / book.startingNav) * 100) : null;
  book.returnStatus = configured ? 'ok' : 'not-configured';
  return book;
}

function findPos(book, symbol) {
  return book.positions.find((row) => row.symbol === symbol) || null;
}

function trimQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (Number.isInteger(n)) return Math.max(1, Math.floor(n / 2));
  return round2(n / 2);
}

function isFullSell(action) {
  return action === 'SELL' || action === 'EXIT';
}

function isReduce(action) {
  return isFullSell(action) || action === 'TRIM';
}

function actionRank(action) {
  if (isFullSell(action)) return 0;
  if (action === 'TRIM') return 1;
  if (action === 'BUY' || action === 'ADD') return 2;
  return 3;
}

function startingCash(accountId, holdings, positions, capital) {
  if (holdings.cash != null && Number.isFinite(Number(holdings.cash))) return Number(holdings.cash);
  if (!positions.length) return capital[accountId] == null ? null : capital[accountId];
  return capital[accountId] == null ? null : 0;
}

function seedAccount(account, holdings, capital) {
  const positions = holdings.missing && account.holdingsKind === 'strategy-not-book'
    ? []
    : clonePositions(holdings.positions);
  const rawCash = startingCash(account.id, holdings, positions, capital);
  const cash = rawCash == null ? null : round2(rawCash);
  const costBasis = round2(positions.reduce((sum, row) => sum + (row.avgCost * row.qty), 0));
  const book = {
    id: account.id,
    label: account.label,
    cash,
    positions,
    seededFrom: account.holdingsFile || `${account.holdingsStem}.json`,
    seedNote: holdings.note || '',
    costBasis
  };
  book.startingCash = cash;
  book.startingCapital = capital[account.id] ?? null;
  const seededNav = cash == null && !positions.length
    ? null
    : round2(Number(cash || 0) + positions.reduce((sum, row) => sum + row.marketValue, 0));
  book.startingNav = seededNav;
  if (!positions.length && (capital[account.id] != null) && book.startingNav === 0) {
    book.cash = round2(capital[account.id]);
    book.startingCash = book.cash;
    book.startingNav = book.cash;
  }
  const configuredNav = book.startingNav;
  markBook(book);
  book.startingNav = configuredNav == null ? null : book.equity;
  book.returnStatus = book.startingNav > 0 ? 'ok' : 'not-configured';
  book.pnlPct = book.startingNav > 0 ? book.pnlPct : null;
  return book;
}

function emptyLedger(id, label, accounts, capital) {
  return {
    id,
    label,
    liveTrading: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapital: capital,
    accounts,
    seed: clone(accounts),
    history: []
  };
}

async function loadSharedSeedHoldings(config) {
  const grokDesk = deskById(config, 'grok');
  const books = {};
  for (const account of grokDesk.accounts) {
    const holdings = await loadHoldings(account);
    if (account.id === 'agentic') {
      const hasBook = Array.isArray(holdings?.positions) && holdings.positions.length > 0;
      books[account.id] = {
        account,
        holdings: hasBook
          ? {
              ...holdings,
              note: '两边共用同一份 Agentic 实盘快照作模拟 Day0，确保起点一致。模拟只跟各自推荐操作；实盘成交记在实际操作，不自动抄进模拟仓。'
            }
          : {
              id: 'agentic',
              label: account.label,
              positions: [],
              cash: DEFAULT_CAPITAL.agentic,
              missing: true,
              note: 'Grok Agentic 持仓档案仍为空。两边模拟 Day0 暂用空仓 + $5000。真实 `持仓/Grok_*` 未改。'
            }
      };
      continue;
    }
    books[account.id] = { account, holdings };
  }
  return books;
}

async function seedLedger(kind, config) {
  const books = await loadSharedSeedHoldings(config);
  const capital = { ...DEFAULT_CAPITAL };
  const accounts = {};
  for (const id of ACCOUNT_IDS) {
    const { account, holdings } = books[id];
    if (id === 'main' && (holdings.cash != null || holdings.costTotal != null)) {
      capital.main = round2(Number(holdings.cash || 0) + Number(holdings.costTotal || 0));
    }
    accounts[id] = seedAccount(account, holdings, capital);
  }
  const label = kind === 'sim-chatgpt' ? 'ChatGPT 模拟操作' : 'Grok 模拟操作';
  return emptyLedger(kind, label, accounts, capital);
}

function ledgerPath(kind) {
  return join(SIM_DIR, `${kind}.json`);
}

async function loadLedger(kind, config) {
  const stored = await readJson(ledgerPath(kind));
  if (stored?.accounts) {
    if (!stored.seed) {
      if ((stored.history || []).length) {
        stored.seedMissing = true;
      } else {
        stored.seed = clone((await seedLedger(kind, config)).accounts);
      }
    }
    return stored;
  }
  return seedLedger(kind, config);
}

async function saveLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  ledger.liveTrading = false;
  await mkdir(SIM_DIR, { recursive: true });
  await writeFile(ledgerPath(ledger.id), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  try {
    const advisor = ledger.id === 'sim-chatgpt' ? 'chatgpt' : 'grok';
    const vaultDir = simVaultDir(advisor);
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, `${ledger.id}.json`), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`模拟账本镜像写入失败 ${ledger.id}:`, error.message);
  }
  return ledger;
}

function advisorName(advisor) {
  return advisor === 'chatgpt' ? 'ChatGPT' : 'Grok';
}

async function loadAdvisorRec(advisor, date) {
  const fileName = `${date}.json`;
  const paths = [
    join(recsDir(advisor), fileName),
    join(recsLegacyDir(advisor), fileName)
  ];
  if (advisor === 'grok') {
    paths.push(join(REPORTS_DIR, `${date}-推荐操作.json`));
    paths.push(join(REPORTS_DIR, `${date}-推荐.json`));
  }
  for (const path of paths) {
    const json = await readJson(path);
    if (Array.isArray(json?.accounts) || Array.isArray(json?.orders)) {
      return {
        json: {
          ...json,
          accounts: Array.isArray(json.accounts) ? json.accounts : []
        },
        path,
        found: true,
        advisor,
        date
      };
    }
  }
  return {
    json: null,
    path: join(recsDir(advisor), fileName),
    found: false,
    advisor,
    date
  };
}

async function loadLatestAdvisorRec(advisor, through) {
  const dates = new Set();
  for (const dir of [recsDir(advisor), recsLegacyDir(advisor)]) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) dates.add(name.slice(0, 10));
    }
  }
  const date = [...dates].filter((day) => !through || day <= through).sort().at(-1);
  if (!date) return loadAdvisorRec(advisor, through);
  return loadAdvisorRec(advisor, date);
}

function last4(value) {
  return String(value || '').replace(/\D/g, '').slice(-4);
}

function accountIdForOrder(order, recFile) {
  const key = last4(order.account);
  if (!key) return null;
  for (const book of recFile.json.accounts || []) {
    if (last4(book.accountLast4) === key) return book.id;
  }
  if (key === '7983') return 'agentic';
  if (key === '3469') return 'tactical';
  return null;
}

export function orderToRec(order) {
  const symbol = String(order.symbol || '').toUpperCase();
  const instrument = instrumentOf(order.instrument);
  const side = String(order.side || '').toLowerCase();
  const qty = order.quantity != null ? Number(order.quantity) : null;
  const rec = {
    symbol,
    instrument,
    tradeQty: Number.isFinite(qty) && qty > 0 ? qty : null,
    limitPrice: order.limit_price != null ? Number(order.limit_price) : null,
    stopPrice: order.stop != null ? Number(order.stop) : null,
    detail: order.rationale || order.detail || '',
    title: order.recommendation_id || '',
    conditions: order.conditions || [],
    recommendation_id: order.recommendation_id,
    fromOrder: true,
    validUntil: order.valid_until ?? order.validUntil ?? null
  };
  if (instrument !== 'equity') {
    rec.action = 'OPTION';
    return rec;
  }
  if (side.includes('buy')) rec.action = 'BUY';
  else if (side.includes('sell')) rec.action = 'TRIM';
  else rec.action = 'WAIT';
  return rec;
}

function recActions(accountId, recFile) {
  const name = advisorName(recFile.advisor);
  const fileName = `${recFile.date}.json`;
  if (!recFile.found) {
    return {
      basis: 'missing-file',
      note: `缺文件：没有 ${name} 推荐操作 ${fileName}。仅保留持仓，不代表已收到 HOLD 建议或当日更新。`,
      recs: []
    };
  }
  const book = (recFile.json.accounts || []).find((row) => row.id === accountId);
  const fromBook = book?.recommendations || [];
  const fromOrders = (recFile.json.orders || [])
    .filter((order) => accountIdForOrder(order, recFile) === accountId)
    .map(orderToRec);
  if (!book && !fromOrders.length && !fromBook.length) {
    return {
      basis: 'missing-file',
      note: `缺文件：${name} 推荐操作 ${fileName} 里没有 ${accountId} 账户。仅保留持仓，不计为该账户更新。`,
      recs: []
    };
  }
  if (!fromOrders.length) {
    return {
      basis: 'daily-rec',
      note: `依据 ${name} 推荐操作 ${fileName}`,
      recs: fromBook
    };
  }
  const orderSymbols = new Set(fromOrders.map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean));
  const extra = fromBook.filter((row) => {
    const action = String(row.action || '').toUpperCase();
    const symbol = String(row.symbol || '').toUpperCase();
    if (['HOLD', 'WATCH'].includes(action)) return false;
    if (orderSymbols.has(symbol) && ['SELL', 'EXIT', 'TRIM', 'BUY', 'ADD'].includes(action)) return false;
    return true;
  });
  return {
    basis: 'daily-rec',
    note: `依据 ${name} 推荐操作 ${fileName}（含精确订单）`,
    recs: [...fromOrders, ...extra]
  };
}

function fillRecord({ symbol, action, qty, price, amount, reason, basis, execution }) {
  return { symbol, action, qty, price, amount, reason, basis, execution, filled: true };
}

function skipRecord({ symbol, action, qty = null, reason, basis }) {
  return { symbol, action, qty, reason, basis, filled: false };
}

function priceBlocked(rec, action, price) {
  for (const cond of rec.conditions || []) {
    const text = String(cond);
    const cancelAbove = text.match(/cancel if price\s*>\s*([0-9.]+)/i);
    if (cancelAbove && price > Number(cancelAbove[1])) {
      return `条件取消：现价 ${price} > ${cancelAbove[1]}`;
    }
    const skipBelow = text.match(/skip.*if price\s*<\s*([0-9.]+)/i);
    if (isReduce(action) && skipBelow && price < Number(skipBelow[1])) {
      return `条件跳过：现价低于 ${skipBelow[1]}`;
    }
  }
  if (rec.limitPrice != null && Number.isFinite(Number(rec.limitPrice))) {
    const limit = Number(rec.limitPrice);
    if ((action === 'BUY' || action === 'ADD') && price > limit) {
      return `现价高于限价 ${limit}，不成交`;
    }
    if (isReduce(action) && price < limit) {
      return `现价低于限价 ${limit}，不成交`;
    }
  }
  return null;
}

function sellQty(action, rec, pos) {
  if (isFullSell(action)) return pos.qty;
  const explicit = rec.tradeQty ?? rec.orderQty;
  if (explicit != null && Number.isFinite(Number(explicit)) && Number(explicit) > 0) {
    return Math.min(Number(explicit), pos.qty);
  }
  return trimQty(pos.qty);
}

export function applyRec(book, rec, quotes, basis) {
  const action = String(rec.action || 'HOLD').toUpperCase();
  const symbol = String(rec.symbol || '').toUpperCase();
  if (['HOLD', 'WATCH'].includes(action)) return { fill: null, skip: null };
  if (!symbol && (action === 'WAIT' || action === 'HOLD')) {
    return { fill: null, skip: skipRecord({ symbol: '', action, reason: rec.title || '无必须执行项，按 HOLD', basis }) };
  }
  if (action === 'WAIT') {
    return { fill: null, skip: skipRecord({ symbol, action, reason: rec.title || rec.detail || 'WAIT，不成交', basis }) };
  }
  if (action === 'OPTION') {
    return {
      fill: null,
      skip: skipRecord({
        symbol,
        action: 'SELL',
        qty: rec.tradeQty ?? rec.qty ?? null,
        reason: rec.detail
          ? `期权不进入股票模拟仓。${rec.detail}`
          : '期权不进入股票模拟仓，不成交',
        basis
      })
    };
  }
  if (action === 'REVIEW') {
    return {
      fill: null,
      skip: skipRecord({
        symbol,
        action,
        qty: rec.qty ?? null,
        reason: rec.detail || 'REVIEW 不是卖单，不自动成交',
        basis
      })
    };
  }
  if (!symbol) {
    return { fill: null, skip: skipRecord({ symbol: '', action, reason: '没有代码，无法成交', basis }) };
  }

  const quote = quotes[symbol];
  const pos = findPos(book, symbol);
  const explicitQty = rec.tradeQty ?? rec.orderQty;
  if (explicitQty != null && (!Number.isFinite(Number(explicitQty)) || !(Number(explicitQty) > 0))) {
    return { fill: null, skip: skipRecord({ symbol, action, reason: '无效数量，必须为有限正数', basis }) };
  }
  const execution = historicalExecution(rec, quote?.bar, rec.generatedAt);
  const price = execution.ok ? execution.price : null;
  if (!price) {
    return { fill: null, skip: skipRecord({ symbol, action, qty: rec.tradeQty ?? rec.qty ?? pos?.qty, reason: execution.reason, basis }) };
  }
  const blocked = priceBlocked(rec, action, price);
  if (blocked) {
    return { fill: null, skip: skipRecord({ symbol, action, qty: rec.tradeQty ?? rec.qty ?? pos?.qty, reason: blocked, basis }) };
  }

  if (isReduce(action)) {
    if (!pos) {
      return { fill: null, skip: skipRecord({ symbol, action, reason: '模拟操作账本无此持仓', basis }) };
    }
    const qty = sellQty(action, rec, pos);
    if (!qty) {
      return { fill: null, skip: skipRecord({ symbol, action, reason: '可卖数量为 0', basis }) };
    }
    const amount = round2(qty * price);
    pos.qty = roundQty(pos.qty - qty);
    book.cash = round2(book.cash + amount);
    if (pos.qty <= 0.0000001) {
      book.positions = book.positions.filter((row) => row.symbol !== symbol);
    } else {
      pos.marketValue = round2(pos.qty * price);
      pos.last = price;
    }
    return {
      fill: fillRecord({
        symbol,
        action,
        qty,
        price,
        amount,
        reason: fillReason(rec, action),
        basis,
        execution
      }),
      skip: null
    };
  }

  if (action === 'BUY' || action === 'ADD') {
    let qty = rec.tradeQty != null ? Number(rec.tradeQty) : null;
    if (qty == null) {
      return {
        fill: null,
        skip: skipRecord({
          symbol,
          action,
          reason: rec.build?.reason || '推荐未给出买入数量，不编造下单股数',
          basis
        })
      };
    }
    const cost = round2(qty * price);
    if (cost > book.cash + 0.009) {
      const maxQty = Math.floor((book.cash / price) * 10000) / 10000;
      if (maxQty <= 0) {
        return { fill: null, skip: skipRecord({ symbol, action, qty, reason: '现金不足', basis }) };
      }
      qty = Number.isInteger(rec.tradeQty) ? Math.floor(maxQty) : maxQty;
      if (qty <= 0) {
        return { fill: null, skip: skipRecord({ symbol, action, reason: '现金不足', basis }) };
      }
    }
    const amount = round2(qty * price);
    book.cash = round2(book.cash - amount);
    if (pos) {
      const newQty = roundQty(pos.qty + qty);
      pos.avgCost = round2(((pos.avgCost * pos.qty) + amount) / newQty);
      pos.qty = newQty;
      pos.last = price;
      pos.marketValue = round2(pos.qty * price);
    } else {
      book.positions.push({
        symbol,
        name: rec.name || symbol,
        qty,
        role: rec.role || (action === 'BUY' ? '模拟新开' : ''),
        theme: rec.theme || '',
        avgCost: price,
        last: price,
        changePct: quote?.changePct ?? null,
        marketValue: amount
      });
    }
    return {
      fill: fillRecord({
        symbol,
        action,
        qty,
        price,
        amount: -amount,
        reason: fillReason(rec, action),
        basis,
        execution
      }),
      skip: null
    };
  }

  return { fill: null, skip: skipRecord({ symbol, action, reason: `未识别动作 ${action}，不成交`, basis }) };
}

function fillReason(rec, action) {
  const build = rec.build;
  const base = rec.detail || rec.title || action;
  if (!build || (build.label !== 'ADD' && build.label !== 'STRONG_ADD')) return base;
  const px = build.decision != null ? `决策价 ${build.decision}` : '';
  return `建仓 ${build.fromPct}%→${build.toPct}% ${px}。${base}`.trim();
}

function settleAccount(book, plan, quotes) {
  const fills = [];
  const skips = [];
  if (plan.basis === 'missing-file' || plan.basis === 'no-rec-hold' || !plan.recs.length) {
    skips.push(skipRecord({
      symbol: '',
      action: plan.basis === 'missing-file' || plan.basis === 'no-rec-hold' ? 'MISSING' : 'HOLD',
      reason: plan.note || '无推荐 / 按 HOLD',
      basis: plan.basis
    }));
    markBook(book, quotes);
    return { fills, skips, plan };
  }

  plan.recs = sizeBuild(book, plan.recs, book.id || 'main');
  const ordered = [...plan.recs].sort((a, b) => actionRank(a.action) - actionRank(b.action));
  for (const rec of ordered) {
    const { fill, skip } = applyRec(book, rec, quotes, plan.basis);
    if (fill) fills.push(fill);
    if (skip) skips.push(skip);
  }
  markBook(book, quotes);
  return { fills, skips, plan };
}

function fillsOn(ledger, date, accountId = 'all') {
  const day = (ledger.history || []).find((row) => row.date === date);
  const fills = day?.fills || [];
  if (accountId === 'all') return fills.length;
  return fills.filter((row) => row.accountId === accountId).length;
}

export function accountReturn(book, capital) {
  const start = Number(book?.startingNav);
  const configured = start > 0 || Number(capital) > 0;
  if (!configured) return { pnlPct: null, returnStatus: 'not-configured' };
  return {
    pnlPct: start > 0 ? round2((Number(book?.pnl) || 0) / start * 100) : null,
    returnStatus: 'ok'
  };
}

function summarizeLedger(ledger) {
  const accounts = ACCOUNT_IDS.map((id) => {
    const book = ledger.accounts[id];
    const ret = accountReturn(book, ledger.startingCapital?.[id] ?? book?.startingCapital);
    return {
      id,
      label: book?.label || id,
      cash: book?.cash ?? 0,
      equity: book?.equity ?? 0,
      startingNav: book?.startingNav ?? null,
      pnl: book?.pnl ?? 0,
      pnlPct: ret.pnlPct,
      returnStatus: ret.returnStatus,
      positionCount: book?.positionCount ?? 0
    };
  });
  const equity = round2(accounts.reduce((sum, row) => sum + row.equity, 0));
  const known = accounts.filter((row) => row.returnStatus === 'ok');
  const startingNav = known.length
    ? round2(known.reduce((sum, row) => sum + Number(row.startingNav || 0), 0))
    : null;
  const pnl = known.length === accounts.length && startingNav != null ? round2(equity - startingNav) : null;
  return {
    equity,
    startingNav,
    pnl,
    pnlPct: pnl != null && startingNav ? round2(pnl / startingNav * 100) : null,
    returnStatus: known.length === accounts.length ? 'ok' : 'not-configured',
    cash: round2(accounts.reduce((sum, row) => sum + row.cash, 0)),
    positionCount: accounts.reduce((sum, row) => sum + row.positionCount, 0),
    accounts
  };
}

function navSeries(ledger, accountId = 'all') {
  const points = [];
  if (ledger.seed) {
    const seed = accountId === 'all'
      ? round2(ACCOUNT_IDS.reduce((sum, id) => sum + Number(ledger.seed[id]?.startingNav || ledger.seed[id]?.equity || 0), 0))
      : Number(ledger.seed[accountId]?.startingNav || ledger.seed[accountId]?.equity || 0);
    points.push(seed);
  }
  for (const day of ledger.history || []) {
    if (accountId === 'all') points.push(day.nav?.total ?? null);
    else points.push(day.nav?.accounts?.[accountId] ?? null);
  }
  return points.filter((n) => n != null);
}

function compareLedgers(grok, chatgpt, accountId = 'all', date) {
  const g = accountId === 'all'
    ? summarizeLedger(grok)
    : summarizeLedger(grok).accounts.find((row) => row.id === accountId);
  const c = accountId === 'all'
    ? summarizeLedger(chatgpt)
    : summarizeLedger(chatgpt).accounts.find((row) => row.id === accountId);
  const grokPnl = g?.pnl ?? 0;
  const gptPnl = c?.pnl ?? 0;
  let leader = 'tie';
  if (grokPnl > gptPnl) leader = 'grok';
  if (gptPnl > grokPnl) leader = 'chatgpt';
  return {
    accountId,
    leader,
    delta: round2(grokPnl - gptPnl),
    grokFills: fillsOn(grok, date, accountId),
    chatgptFills: fillsOn(chatgpt, date, accountId),
    grokCash: g?.cash ?? 0,
    chatgptCash: c?.cash ?? 0,
    grokPositions: g?.positionCount ?? 0,
    chatgptPositions: c?.positionCount ?? 0,
    grok: g,
    chatgpt: c
  };
}

function renderSimMarkdown(date, grok, chatgpt, lastRun) {
  const g = summarizeLedger(grok);
  const c = summarizeLedger(chatgpt);
  const leader = lastRun?.compare?.all?.leader || (g.pnl >= c.pnl ? 'grok' : 'chatgpt');
  const rows = ACCOUNT_IDS.map((id) => {
    const ga = g.accounts.find((row) => row.id === id);
    const ca = c.accounts.find((row) => row.id === id);
    const gf = fillsOn(grok, date, id);
    const cf = fillsOn(chatgpt, date, id);
    return `| ${ga.label} | ${money(ga.equity)} | ${money(ca.equity)} | ${money(ga.pnl)} | ${money(ca.pnl)} | ${gf} | ${cf} | ${ga.pnl >= ca.pnl ? 'Grok' : 'ChatGPT'} |`;
  }).join('\n');
  return `---
title: 模拟操作对照
date: ${date}
type: sim-operation
liveTrading: false
---

# 模拟操作对照（纸上跟单）

> 这不是实盘，也不会覆盖 \`持仓/Grok_*\` 或 ChatGPT 手册正文。
> 两边都只解析各自 \`推荐操作/YYYY-MM-DD.json\`。Markdown 给人看。缺文件则 HOLD，不编造买卖。

- 结算日：${date}
- 累计领先：${leader === 'tie' ? '打平' : leader === 'grok' ? 'Grok' : 'ChatGPT'}
- Grok 合计 ${money(g.equity)}（${money(g.pnl)}，当日成交 ${fillsOn(grok, date, 'all')} 笔）
- ChatGPT 合计 ${money(c.equity)}（${money(c.pnl)}，当日成交 ${fillsOn(chatgpt, date, 'all')} 笔）
- 同价成交时净值几乎不变，差别看成交笔数和持仓结构，不要只看净值打平。

| 账户 | Grok 净值 | ChatGPT 净值 | Grok 盈亏 | ChatGPT 盈亏 | Grok 成交 | ChatGPT 成交 | 领先 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}
| 合计 | ${money(g.equity)} | ${money(c.equity)} | ${money(g.pnl)} | ${money(c.pnl)} | ${fillsOn(grok, date, 'all')} | ${fillsOn(chatgpt, date, 'all')} | ${g.pnl >= c.pnl ? 'Grok' : 'ChatGPT'} |
`;
}

function renderSimDayMarkdown(date, advisor, recFile, day) {
  const name = advisorName(advisor);
  const recLine = recFile?.found
    ? `依据 ${name} 推荐操作 ${recFile.date}.json`
    : `缺文件：当日没有 ${name} 推荐操作 ${date}.json。按 HOLD，不编造买卖。`;
  const fills = (day.fills || []).map((row) => (
    `| ${row.accountId || ''} | ${row.symbol || '—'} | ${row.action} | ${row.qty ?? ''} | ${row.price ?? ''} | ${row.amount ?? ''} | ${row.reason || ''} |`
  )).join('\n');
  const skips = (day.skips || []).map((row) => (
    `| ${row.accountId || ''} | ${row.symbol || '—'} | ${row.action} | ${row.basis || ''} | ${row.reason || ''} |`
  )).join('\n');
  return `---
title: ${name} 模拟操作
date: ${date}
advisor: ${advisor}
liveTrading: false
type: sim-operation
---

# ${date} ${name} 模拟操作

> ${recLine}
> 本文件是跟单结果，不是推荐原文。推荐在 \`推荐操作/\`。

## 成交

| 账户 | 代码 | 动作 | 数量 | 价格 | 金额 | 说明 |
| --- | --- | --- | ---: | ---: | ---: | --- |
${fills || '|  |  | HOLD |  |  |  | 当日无成交 |'}

## HOLD / 缺文件 / 未跟单

| 账户 | 代码 | 动作 | 依据 | 原因 |
| --- | --- | --- | --- | --- |
${skips || '|  |  | HOLD |  | 无跳过记录 |'}
`;
}

async function writeSimDayFiles(advisor, date, recFile, day) {
  try {
    const dir = simVaultDir(advisor);
    await mkdir(dir, { recursive: true });
    const payload = {
      date,
      advisor,
      liveTrading: false,
      type: 'sim-operation',
      recFile: recFile
        ? { found: recFile.found, path: recFile.path, date: recFile.date }
        : { found: false, path: null, date },
      fills: day.fills || [],
      skips: day.skips || [],
      plans: day.plans || {},
      nav: day.nav || null,
      pnl: day.pnl || null
    };
    await writeFile(join(dir, `${date}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(join(dir, `${date}.md`), renderSimDayMarkdown(date, advisor, recFile, day), 'utf8');
  } catch (error) {
    console.error(`模拟操作日档写入失败 ${advisor} ${date}:`, error.message);
  }
}

async function writeCompareMarkdown(date, grok, chatgpt, lastRun) {
  try {
    const dir = simVaultDir('grok');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '对照.md'), renderSimMarkdown(date, grok, chatgpt, lastRun), 'utf8');
  } catch (error) {
    console.error(`模拟对照写入失败 ${date}:`, error.message);
  }
}

function recDisclaimer(advisor, recFile, lastPlanNote) {
  const name = advisorName(advisor);
  if (lastPlanNote) return lastPlanNote;
  if (recFile && !recFile.found) {
    return `缺文件：当日没有 ${name} 推荐操作 ${recFile.date}.json。按 HOLD，不编造买卖。`;
  }
  return `${name} 模拟操作只解析当日推荐操作 JSON。Markdown 给人看。没有推荐操作文件则按 HOLD，不编造买卖。`;
}

function lastPlanNote(ledger) {
  const day = ledger.history?.at(-1);
  if (!day?.plans) return '';
  const notes = ACCOUNT_IDS.map((id) => day.plans[id]?.note).filter(Boolean);
  const missing = notes.find((note) => note.includes('缺文件'));
  return missing || notes[0] || '';
}

function publicLedger(ledger, recFile, accountId = 'all', buildRec = null) {
  const summary = summarizeLedger(ledger);
  const advisor = ledger.id === 'sim-chatgpt' ? 'chatgpt' : 'grok';
  return {
    id: ledger.id,
    label: ledger.label,
    liveTrading: false,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    startingCapital: ledger.startingCapital,
    recFile: recFile
      ? { found: recFile.found, path: recFile.path, date: recFile.date, advisor: recFile.advisor }
      : null,
    summary,
    navSeries: {
      all: navSeries(ledger, 'all'),
      main: navSeries(ledger, 'main'),
      tactical: navSeries(ledger, 'tactical'),
      agentic: navSeries(ledger, 'agentic')
    },
    accounts: ledger.accounts,
    history: ledger.history,
    disclaimer: recDisclaimer(advisor, recFile, lastPlanNote(ledger)),
    build: previewBuilds(ledger, buildRec || recFile)
  };
}

function previewBuilds(ledger, recFile) {
  const signalDate = recFile?.found ? recFile.date : null;
  const executeDate = signalDate ? nextSessionStamp(signalDate) : null;
  const settled = Boolean(executeDate && (ledger.history || []).some((row) => row.date === executeDate));
  const accounts = {};
  for (const id of ACCOUNT_IDS) {
    const book = ledger.accounts?.[id] || { id, cash: 0, positions: [] };
    const plan = recFile ? recActions(id, recFile) : { basis: 'missing-file', note: '缺文件', recs: [] };
    const sized = plan.basis === 'daily-rec' ? sizeBuild(book, plan.recs, id) : [];
    accounts[id] = {
      ...buildCard(book, sized, id, { signalDate, executeDate, settled }),
      basis: plan.basis,
      note: plan.note
    };
  }
  return {
    signalDate,
    executeDate,
    settled,
    liveTrading: false,
    note: '模拟组合。只给推荐里的 BUY/ADD 建仓，缺文件不编造。下一交易日开盘 + 5bp。不是下单。',
    accounts
  };
}

async function listRecDates(advisor) {
  const dates = new Set();
  for (const dir of [recsDir(advisor), recsLegacyDir(advisor)]) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) dates.add(name.slice(0, 10));
    }
  }
  return [...dates].sort();
}

function previousSession(day) {
  return lastSessionStamp(new Date(new Date(`${day}T12:00:00-05:00`).getTime() - 86400000));
}

/** Next-open: settle S uses the newest rec dated in [previous session, S), so weekend recs count. */
export function pickRecDate(recDates, settleDate) {
  const from = previousSession(settleDate);
  return recDates.filter((day) => day >= from && day < settleDate).sort().at(-1) || null;
}

export function sessionDaysBetween(start, end) {
  const out = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  for (let i = 0; i < 4000; i++) {
    const day = cursor.toISOString().slice(0, 10);
    if (day > end) break;
    if (isUsSessionDay(day)) out.push(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function ledgerStartDate(ledger) {
  if (ledger.seedDate) return ledger.seedDate;
  const first = (ledger.history || []).map((row) => row.date).filter(Boolean).sort()[0];
  if (first) return first;
  const created = ledger.createdAt ? todayStamp(new Date(ledger.createdAt)) : todayStamp();
  const horizon = new Date(`${created}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 14);
  return sessionDaysBetween(created, horizon.toISOString().slice(0, 10)).find((day) => day > created) || created;
}

export async function catchUpMissingSimDays({ through } = {}) {
  const result = await runSimSettlement({ date: through });
  return { ok: true, rebuilt: result.rebuilt, last: result };
}

export async function getSimState(accountId = 'all', recDate) {
  const config = await loadConfig();
  const grok = await loadLedger('sim-grok', config);
  const chatgpt = await loadLedger('sim-chatgpt', config);
  // Reading the comparison must not create or advance any ledger.
  const lastDate = [...grok.history, ...chatgpt.history].map((day) => day.date).filter(Boolean).sort().at(-1) || null;
  const observationDate = lastSessionStamp();
  const date = recDate || observationDate;
    const grokRec = await loadAdvisorRec('grok', date);
    const chatgptRec = await loadAdvisorRec('chatgpt', date);
    const grokBuildRec = grokRec.found ? grokRec : await loadLatestAdvisorRec('grok', date);
    const chatgptBuildRec = chatgptRec.found ? chatgptRec : await loadLatestAdvisorRec('chatgpt', date);
    const freshness = await loadChatgptFreshness(config, chatgpt, observationDate);
    return {
      generatedAt: new Date().toISOString(),
      today: todayStamp(),
      observationDate,
      liveTrading: false,
      accountId,
      lastDate,
      recDate: date,
      grok: publicLedger(grok, grokRec, accountId, grokBuildRec),
      chatgpt: { ...publicLedger(chatgpt, chatgptRec, accountId, chatgptBuildRec), freshness },
    compare: {
      all: compareLedgers(grok, chatgpt, 'all', lastDate),
      main: compareLedgers(grok, chatgpt, 'main', lastDate),
      tactical: compareLedgers(grok, chatgpt, 'tactical', lastDate),
      agentic: compareLedgers(grok, chatgpt, 'agentic', lastDate)
    }
  };
}

export async function resetSim({ book = 'all' } = {}) {
  const config = await loadConfig();
  const kinds = book === 'grok' || book === 'sim-grok'
    ? ['sim-grok']
    : book === 'chatgpt' || book === 'sim-chatgpt'
      ? ['sim-chatgpt']
      : SIM_BOOKS;
  for (const kind of kinds) {
    const ledger = await seedLedger(kind, config);
    await saveLedger(ledger);
  }
  return {
    ok: true,
    liveTrading: false,
    reset: kinds,
    ...await getSimState()
  };
}

function recSymbols(recFile) {
  const out = [];
  if (!recFile?.found) return out;
  for (const book of recFile.json.accounts || []) {
    for (const rec of book.recommendations || []) if (rec.symbol) out.push(String(rec.symbol).toUpperCase());
  }
  for (const order of recFile.json.orders || []) if (order.symbol) out.push(String(order.symbol).toUpperCase());
  return out;
}

function settleLedgerDay(ledger, recFile, day, quotes) {
  const fills = [];
  const skips = [];
  const plans = {};
  for (const id of ACCOUNT_IDS) {
    const book = ledger.accounts[id];
    const plan = recActions(id, recFile);
    plans[id] = { basis: plan.basis, note: plan.note };
    plan.recs = plan.recs.map((rec) => ({ ...rec, generatedAt: rec.generatedAt || recFile.json?.generatedAt || recFile.json?.timestamp, validUntil: rec.validUntil ?? rec.valid_until ?? recFile.json?.valid_until }));
    const result = settleAccount(book, plan, quotes);
    fills.push(...result.fills.map((row) => ({ ...row, accountId: id })));
    skips.push(...result.skips.map((row) => ({ ...row, accountId: id })));
  }
  for (const id of ACCOUNT_IDS) {
    const book = ledger.accounts[id];
    for (const pos of book.positions) {
      if (!quotes[pos.symbol]?.ok) skips.push({ ...skipRecord({ symbol: pos.symbol, action: 'MARK', reason: `缺 ${day} 日线，沿用上一收盘估值`, basis: 'valuation' }), accountId: id });
    }
    markBook(book, quotes);
  }
  const summary = summarizeLedger(ledger);
  const row = {
    date: day,
    generatedAt: new Date().toISOString(),
    executionModel: 'next-open-v2',
    signalDate: recFile.date,
    recFound: recFile.found,
    liveTrading: false,
    plans,
    fills,
    skips,
    nav: {
      total: summary.equity,
      cash: summary.cash,
      accounts: Object.fromEntries(summary.accounts.map((r) => [r.id, r.equity]))
    },
    pnl: {
      total: summary.pnl,
      accounts: Object.fromEntries(summary.accounts.map((r) => [r.id, r.pnl]))
    }
  };
  ledger.history.push(row);
  return row;
}

function rowFingerprint(row) {
  if (!row) return '';
  const fills = (row.fills || []).map((f) => [f.accountId, f.symbol, f.action, f.qty, f.price]);
  return JSON.stringify([fills, row.nav?.total]);
}

/**
 * Ledger = f(seed, rec files, daily bars). Every run rebuilds from seed through the target session,
 * so missed days, late recs and same-day reruns all converge to the same books.
 */
export async function runSimSettlement({ date, dryRun = false } = {}) {
  const config = await loadConfig();
  const requested = date || todayStamp();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || !isUsSessionDay(requested) || !sessionClosed(requested)) throw new Error('模拟结算只允许已收盘的交易日');
  const grok = await loadLedger('sim-grok', config);
  const chatgpt = await loadLedger('sim-chatgpt', config);
  if (grok.seedMissing || chatgpt.seedMissing) throw new Error('模拟账本缺 seed，无法从 seed 重放；不会拿当前持仓冒充 seed，请人工确认后重置');

  const latestStored = [...grok.history, ...chatgpt.history].map((row) => row.date).filter(Boolean).sort().at(-1) || null;
  const through = latestStored && latestStored > requested ? latestStored : requested;
  const books = [
    { ledger: grok, advisor: 'grok', start: ledgerStartDate(grok) },
    { ledger: chatgpt, advisor: 'chatgpt', start: ledgerStartDate(chatgpt) }
  ];
  const recDates = { grok: await listRecDates('grok'), chatgpt: await listRecDates('chatgpt') };
  const recCache = new Map();
  const recFor = async (advisor, day) => {
    const picked = pickRecDate(recDates[advisor], day) || previousSession(day);
    const key = `${advisor}:${picked}`;
    if (!recCache.has(key)) recCache.set(key, await loadAdvisorRec(advisor, picked));
    return recCache.get(key);
  };

  const start = books.map((b) => b.start).sort()[0];
  const days = sessionDaysBetween(start, through).filter((day) => sessionClosed(day));
  const symbols = new Set();
  for (const b of books) {
    for (const book of Object.values(b.ledger.seed || {})) for (const pos of book.positions || []) symbols.add(pos.symbol);
  }
  const schedule = [];
  for (const day of days) {
    const recs = {};
    for (const b of books) {
      if (day < b.start) continue;
      recs[b.advisor] = await recFor(b.advisor, day);
      for (const sym of recSymbols(recs[b.advisor])) symbols.add(sym);
    }
    schedule.push({ day, recs });
  }

  const hists = await loadManyHistoricals([...symbols, 'QQQ']);
  const bars = Object.fromEntries(Object.entries(hists).map(([sym, h]) => [sym, new Map((h?.bars || []).map((bar) => [bar.date, bar]))]));
  const before = Object.fromEntries(books.map((b) => [b.advisor, new Map((b.ledger.history || []).map((row) => [row.date, row]))]));
  for (const b of books) {
    b.ledger.accounts = clone(b.ledger.seed);
    b.ledger.history = [];
    b.ledger.seedDate = b.start;
  }

  const changed = { grok: [], chatgpt: [] };
  const missingBars = new Set();
  let settledThrough = null;
  for (const { day, recs } of schedule) {
    if (!bars.QQQ?.has(day)) {
      if (latestStored && day <= latestStored) throw new Error(`历史日线缺 ${day}（QQQ），无法全量重放；保留原账本`);
      break;
    }
    const quotes = {};
    for (const sym of symbols) {
      const bar = bars[sym]?.get(day);
      quotes[sym] = { symbol: sym, ok: Boolean(bar), last: bar?.close ?? null, bar, source: hists[sym]?.source };
    }
    for (const b of books) {
      if (!recs[b.advisor]) continue;
      const row = settleLedgerDay(b.ledger, recs[b.advisor], day, quotes);
      for (const skip of row.skips) if (skip.action === 'MARK') missingBars.add(skip.symbol);
      if (rowFingerprint(row) !== rowFingerprint(before[b.advisor].get(day))) changed[b.advisor].push(day);
    }
    settledThrough = day;
  }

  const rowOn = (ledger, day) => (ledger.history || []).find((row) => row.date === day) || null;
  const rebuilt = {
    from: start,
    through: settledThrough,
    days: schedule.filter((s) => !settledThrough || s.day <= settledThrough).length,
    changed,
    dropped: Object.fromEntries(books.map((b) => [b.advisor, [...before[b.advisor].keys()].filter((day) => !rowOn(b.ledger, day))]))
  };
  if (dryRun) {
    return { ok: true, dryRun: true, liveTrading: false, date: requested, rebuilt, missingBars: [...missingBars] };
  }

  if (books.some((b) => changed[b.advisor].some((day) => day < requested))) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(SIM_DIR, 'backup');
    await mkdir(dir, { recursive: true });
    for (const kind of SIM_BOOKS) {
      try {
        await copyFile(ledgerPath(kind), join(dir, `${stamp}-${kind}.json`));
      } catch {}
    }
  }
  await saveLedger(grok);
  await saveLedger(chatgpt);
  for (const b of books) {
    const toWrite = new Set([...changed[b.advisor], ...(settledThrough ? [settledThrough] : [])]);
    for (const day of toWrite) {
      const row = rowOn(b.ledger, day);
      if (row) await writeSimDayFiles(b.advisor, day, recCache.get(`${b.advisor}:${row.signalDate}`) || await loadAdvisorRec(b.advisor, row.signalDate), row);
    }
  }
  if (!settledThrough || settledThrough < requested) {
    throw new Error(`还没有 ${requested} 的 QQQ 日线；已全量重放到 ${settledThrough || '—'}`);
  }
  const state = await getSimState('all', requested);
  await writeCompareMarkdown(requested, grok, chatgpt, state);

  const grokRow = rowOn(grok, requested);
  const gptRow = rowOn(chatgpt, requested);
  const grokRec = grokRow ? recCache.get(`grok:${grokRow.signalDate}`) : null;
  const gptRec = gptRow ? recCache.get(`chatgpt:${gptRow.signalDate}`) : null;
  return {
    ok: true,
    alreadySettled: false,
    replayed: true,
    rebuilt,
    date: requested,
    liveTrading: false,
    grokRecFound: Boolean(grokRec?.found),
    grokRecPath: grokRec?.path || null,
    chatgptRecFound: Boolean(gptRec?.found),
    chatgptRecPath: gptRec?.path || null,
    quotesFailed: [...missingBars],
    lastRun: {
      grok: grokRow ? { fills: grokRow.fills, skips: grokRow.skips, plans: grokRow.plans } : { fills: [], skips: [], plans: {} },
      chatgpt: gptRow ? { fills: gptRow.fills, skips: gptRow.skips, plans: gptRow.plans } : { fills: [], skips: [], plans: {} }
    },
    ...state
  };
}
