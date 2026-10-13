import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asOfStamp,
  calendarWarning,
  OBSIDIAN_DAILY,
  OBSIDIAN_ORACLE,
  REPORTS_DIR,
  actualsDir,
  recsDir,
  simVaultDir,
  isUsSessionDay,
  lastSessionStamp,
  todayStamp
} from './paths.js';
import { sessionClosed } from './market-time.js';
import {
  applyScan,
  holdingsFreshness,
  loadAccounts,
  loadHoldings,
  markHoldingsStale,
  markScanUnavailable,
  refreshHoldingPrices
} from './holdings.js';
import { writeAgenticNarrative } from './narrative.js';
import { buildRecommendations } from './recommend.js';
import { runSimSettlement } from './sim.js';
import { ensureActualsDirs, extractFillsFromScans, recordDailyActuals } from './actuals.js';
import { buildTradableDesk, writeTradable } from './tradable.js';
import { buildOptionsDesk, writeOptions } from './options/engine.js';
import { listPaperViews } from './paper/desk.js';
import { runPaperOpen } from './paper/auto.js';
import { buildAndWriteWatchlist } from './strategy/watchlist.js';
import { summarizeDailyJob } from './daily-status.js';

const SCAN_IDS = ['tactical', 'agentic'];

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 模拟只结算已收盘的交易日。开盘扫描在美东 10:00 左右，当天没收盘，结算上一个交易日。 */
export function simSettleDate(date, now = new Date()) {
  if (isUsSessionDay(date) && sessionClosed(date, now)) return date;
  return lastSessionStamp(new Date(Date.parse(`${date}T12:00:00-05:00`) - 86400000));
}

/** 每日任务必须落盘的 Grok 文件。缺推荐操作 JSON 视为失败。模拟文件按应结算日核验。 */
export async function verifyDailyOutputs(date, { simDate } = {}) {
  const day = date || todayStamp();
  const settled = simDate || simSettleDate(day);
  const required = [
    ['grokRecJson', join(recsDir('grok'), `${day}.json`)],
    ['grokRecMd', join(recsDir('grok'), `${day}.md`)],
    ['grokSimJson', join(simVaultDir('grok'), `${settled}.json`)],
    ['grokSimMd', join(simVaultDir('grok'), `${settled}.md`)],
    ['grokActualJson', join(actualsDir('grok'), `${day}.json`)],
    ['grokActualMd', join(actualsDir('grok'), `${day}.md`)],
    ['grokDailyMd', join(OBSIDIAN_DAILY, `${day}.md`)]
  ];
  const files = {};
  const missing = [];
  for (const [key, path] of required) {
    const ok = await exists(path);
    files[key] = { path, ok };
    if (!ok) missing.push(path);
  }
  return {
    date: day,
    ok: files.grokRecJson.ok,
    complete: missing.length === 0,
    missing,
    files
  };
}

function compactRec(payload) {
  if (!payload) return null;
  return {
    date: payload.date,
    advisor: payload.advisor,
    liveTrading: false,
    preserved: Boolean(payload.preserved),
    orderCount: Array.isArray(payload.orders) ? payload.orders.length : 0,
    accounts: (payload.accounts || []).map((row) => ({
      id: row.id,
      positionCount: row.positionCount,
      priorities: row.priorities
    }))
  };
}

async function refreshRealHoldings({ scans = {}, scanErrors = {}, scanFailed = '', skipScan = false, date }) {
  const config = await loadAccounts('grok');
  const out = {};
  for (const account of config.accounts) {
    if (account.id === 'main' || account.source === 'manual') {
      const book = await loadHoldings(account);
      out.main = {
        ok: true,
        scanned: false,
        source: 'manual',
        asOf: book.asOf || null,
        positionCount: (book.positions || []).length,
        note: '主账户无接口：未扫描覆盖，只读现有手改档案。推荐里可以给动作。'
      };
      continue;
    }
    if (!SCAN_IDS.includes(account.id)) continue;
    const scan = scans[account.id];
    const err = scanErrors[account.id] || (scanFailed ? scanFailed : '');
    if (scan) {
      try {
        const book = await applyScan(account, scan);
        out[account.id] = {
          ok: true,
          scanned: true,
          stale: false,
          asOf: book.asOf,
          positionCount: (book.positions || []).length,
          optionCount: (book.optionPositions || []).length,
          openOrderCount: (book.openOrders || []).length,
          note: book.note
        };
      } catch (error) {
        const book = await markScanUnavailable(account, { reason: error.message, date });
        out[account.id] = {
          ok: false,
          scanned: false,
          stale: true,
          asOf: book.asOf,
          error: error.message,
          note: book.note
        };
      }
      continue;
    }
    if (err) {
      const book = await markScanUnavailable(account, { reason: err, date });
      out[account.id] = {
        ok: false,
        scanned: false,
        stale: true,
        asOf: book.asOf,
        error: err,
        note: book.note
      };
      continue;
    }
    let book = await loadHoldings(account);
    if (!holdingsFreshness(book, date).fresh) {
      try {
        book = await refreshHoldingPrices(account, { date });
      } catch (error) {
        book = await markHoldingsStale(account, {
          reason: `公开行情刷新失败：${error.message}。上次券商扫描 ${book.asOf || book.dataAsOf || '无'}。`
        });
      }
      if (!holdingsFreshness(book, date).fresh) {
        book = await markHoldingsStale(account, {
          reason: book.note || `公开行情没补全。上次券商扫描 ${book.asOf || book.dataAsOf || '无'}。`
        });
      }
    }
    const fresh = holdingsFreshness(book, date).fresh;
    const last = book.priceAsOf || book.asOf || book.dataAsOf || null;
    out[account.id] = {
      ok: fresh,
      scanned: false,
      stale: !fresh,
      asOf: book.asOf || null,
      priceAsOf: book.priceAsOf || null,
      asOfDay: asOfStamp(last),
      positionCount: (book.positions || []).length,
      note: book.note || (fresh
        ? '沿用今日已有扫描。本机未再请求 Robinhood。'
        : `缺数据：本机无 Robinhood 接口，未覆盖持仓。上次可靠扫描 ${book.asOf || '无'}。`)
    };
  }
  return out;
}

export async function runDailyJob(opts = {}) {
  const liveTrading = false;
  const date = opts.date || todayStamp();
  await ensureActualsDirs();

  const holdings = await refreshRealHoldings({
    scans: opts.scans || {},
    scanErrors: opts.scanErrors || {},
    scanFailed: opts.scanFailed || '',
    skipScan: opts.skipScan !== false && !opts.scans?.tactical && !opts.scans?.agentic,
    date
  });

  let narrative = null;
  try {
    narrative = await writeAgenticNarrative({
      date,
      fills: (opts.fills || []).filter((row) => (row.accountId || row.account) === 'agentic')
    });
  } catch (error) {
    narrative = { ok: false, error: error.message };
  }

  let grokRecs = null;
  let chatgptRecs = null;
  let chatgptRecNote = '';
  const freshScan = Boolean(opts.scans?.tactical || opts.scans?.agentic);
  const existingGrok = await readJsonFile(join(recsDir('grok'), `${date}.json`));
  try {
    grokRecs = !freshScan && !opts.forceRecs && existingGrok?.date === date && Array.isArray(existingGrok.accounts) && existingGrok.accounts.length
      ? { ...existingGrok, reused: true }
      : await buildRecommendations({ advisor: 'grok' });
  } catch (error) {
    grokRecs = { error: error.message };
  }
  try {
    chatgptRecs = await buildRecommendations({ advisor: 'chatgpt' });
    if (chatgptRecs?.preserved) {
      chatgptRecNote = chatgptRecs.preservedReason;
    }
  } catch (error) {
    chatgptRecNote = `ChatGPT 推荐引擎失败：${error.message}。今日仅 Grok 生成。`;
  }
  if (!chatgptRecs && !chatgptRecNote) {
    chatgptRecNote = '今日仅 Grok 生成。';
  }

  const simDate = simSettleDate(date);
  let sim = null;
  try {
    sim = await runSimSettlement({ date: simDate });
  } catch (error) {
    sim = { date: simDate, error: error.message, message: error.message };
  }

  const allFills = (() => {
    const seen = new Set();
    const merged = [...(opts.fills || []), ...extractFillsFromScans(opts.scans || {})];
    return merged.filter((row) => {
      const key = row.orderId || `${row.accountId}:${row.symbol}:${row.createdAt}:${row.qty}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  const grokActuals = await recordDailyActuals({
    date,
    advisor: 'grok',
    fills: allFills.filter((row) => (row.advisor || 'grok') !== 'chatgpt')
  });
  const chatgptActuals = await recordDailyActuals({
    date,
    advisor: 'chatgpt',
    fills: allFills.filter((row) => row.advisor === 'chatgpt')
  });

  let tradable = null;
  try {
    tradable = await buildTradableDesk({ date });
    await writeTradable(tradable);
  } catch (error) {
    tradable = { ok: false, error: error.message, ideas: [] };
  }

  const posters = { ok: true, accounts: {}, error: null };
  try {
    const { buildAccountPosters, writePosters } = await import('./posters.js');
    const failed = [];
    for (const accountId of ['main', 'tactical', 'agentic']) {
      try {
        const pack = await buildAccountPosters({ accountId, deskId: 'grok' });
        if (!pack.ok) throw new Error(pack.error || '无持仓');
        await writePosters(pack);
        posters.accounts[accountId] = pack.cards?.length ?? 0;
      } catch (error) {
        posters.accounts[accountId] = 0;
        failed.push(`${accountId}：${error.message}`);
      }
    }
    if (failed.length === 3) posters.error = failed.join('；');
  } catch (error) {
    posters.error = error.message;
  }
  if (posters.error) posters.ok = false;

  let options = null;
  try {
    options = await buildOptionsDesk({ date, strategyId: 'cov' });
    await writeOptions(options);
  } catch (error) {
    options = { ok: false, error: error.message, buys: [], tempting: [] };
  }

  let watchlist = null;
  try {
    watchlist = await buildAndWriteWatchlist({ date });
  } catch (error) {
    watchlist = { ok: false, error: error.message, boards: {} };
  }

  let watchlistCn = null;
  try {
    const { buildAndWriteCnWatchlist } = await import('./strategy/watchlist-cn.js');
    watchlistCn = await buildAndWriteCnWatchlist({});
  } catch (error) {
    watchlistCn = { ok: false, error: error.message };
  }

  const oracle = { ok: true, qimen: null, us: null, cn: null, error: null };
  try {
    const { ensureOracleWrite } = await import('./oracle/qimen.js');
    const pack = await ensureOracleWrite({ date, refresh: true });
    if (pack.generatedChart) {
      const { buildCurrentQimen } = await import('./oracle/qimen-current.js');
      const current = await buildCurrentQimen({});
      await mkdir(OBSIDIAN_ORACLE, { recursive: true });
      await writeFile(join(OBSIDIAN_ORACLE, `${date}-current.json`), `${JSON.stringify({ ...current, liveTrading: false }, null, 2)}\n`, 'utf8');
      oracle.qimen = '本时盘已写';
    } else if (pack.empty) {
      oracle.qimen = pack.error || '无盘面';
    } else {
      oracle.qimen = '已写';
    }
  } catch (error) {
    oracle.qimen = `失败：${error.message}`;
  }
  try {
    const { buildSymbolOracle } = await import('./oracle/symbols.js');
    const { oracleAccuracy, chinaOracleAccuracy } = await import('./oracle/accuracy.js');
    for (const [market, store] of [['us', oracleAccuracy], ['cn', chinaOracleAccuracy]]) {
      try {
        const res = await store.refresh(await buildSymbolOracle({ market }));
        oracle[market] = res.capture || '已结算';
      } catch (error) {
        oracle[market] = `失败：${error.message}`;
      }
    }
  } catch (error) {
    oracle.us = oracle.cn = `失败：${error.message}`;
  }
  const oracleFailed = ['qimen', 'us', 'cn'].filter((key) => String(oracle[key] || '').startsWith('失败'));
  if (oracleFailed.length === 3) {
    oracle.ok = false;
    oracle.error = oracle.qimen;
  }

  let brief = null;
  try {
    const { buildAndWriteAgenticBrief } = await import('./agentic-brief.js');
    brief = await buildAndWriteAgenticBrief({
      date,
      watchlist,
      options,
      recs: grokRecs?.error ? null : grokRecs
    });
  } catch (error) {
    brief = { ok: false, error: error.message };
  }

  const payload = {
    ok: true,
    liveTrading,
    date,
    generatedAt: new Date().toISOString(),
    steps: ['真实持仓', '叙事日报', '推荐操作', '模拟操作', '实际操作', '今日买卖', '价位图', '期权推荐', '每日观察', '算卦', 'Agentic意见', '止损护栏', '纸上实验自动'],
    posters,
    oracle,
    holdings,
    narrative: narrative
      ? { date: narrative.date, stance: narrative.stance, nav: narrative.nav, stale: narrative.stale, error: narrative.error || null }
      : null,
    recommendations: {
      grok: compactRec(grokRecs?.error ? null : grokRecs),
      grokError: grokRecs?.error || null,
      chatgpt: compactRec(chatgptRecs),
      chatgptNote: chatgptRecNote || (chatgptRecs ? '' : '今日仅 Grok 生成。')
    },
    sim: {
      date: sim.date,
      alreadySettled: sim.alreadySettled,
      replayed: sim.replayed,
      grokRecFound: sim.grokRecFound,
      chatgptRecFound: sim.chatgptRecFound,
      grokFills: sim.lastRun?.grok?.fills?.length ?? 0,
      chatgptFills: sim.lastRun?.chatgpt?.fills?.length ?? 0,
      message: sim.message || null,
      error: sim.error || null,
      waitsForClose: simDate !== date
    },
    actuals: {
      grok: { empty: grokActuals.empty, added: grokActuals.added, message: grokActuals.message },
      chatgpt: { empty: chatgptActuals.empty, added: chatgptActuals.added, message: chatgptActuals.message }
    },
    tradable: {
      ok: Boolean(tradable?.ok),
      date: tradable?.date || date,
      count: tradable?.ideas?.length ?? 0,
      counts: tradable?.counts || null,
      error: tradable?.error || null
    },
    options: {
      ok: Boolean(options?.ok),
      date: options?.date || date,
      strategy: options?.strategy?.id || 'cov',
      buyCount: options?.buys?.length ?? 0,
      temptingCount: options?.tempting?.length ?? 0,
      scanned: options?.scanned ?? 0,
      score: options?.score?.locked || null,
      error: options?.error || null
    },
    watchlist: {
      ok: Boolean(watchlist?.ok),
      date: watchlist?.date || date,
      regime: watchlist?.regimeLabel || watchlist?.regime || null,
      scanned: watchlist?.scanned ?? 0,
      counts: watchlist?.counts || null,
      score: watchlist?.score?.locked || null,
      error: watchlist?.error || null
    },
    watchlistCn: {
      ok: Boolean(watchlistCn?.ok),
      date: watchlistCn?.date || null,
      scanned: watchlistCn?.scanned ?? 0,
      counts: watchlistCn?.counts || null,
      error: watchlistCn?.error || null
    },
    brief: {
      ok: Boolean(brief?.ok),
      date: brief?.date || date,
      stance: brief?.stance || null,
      headline: brief?.headline || null,
      consider: brief?.actions?.consider?.map((row) => row.symbol) || [],
      exit: brief?.actions?.exit?.map((row) => row.symbol) || [],
      error: brief?.error || null
    }
  };

  try {
    const { getRiskView } = await import('./risk/service.js');
    const view = await getRiskView('live');
    payload.risk = {
      ok: true,
      mode: view.mode,
      modeReason: view.modeReason,
      pnlDay: view.book?.realizedPnlToday ?? 0,
      pnlWeek: view.book?.realizedPnlWeek ?? 0,
      note: view.book?.realizedNote || 'Agentic 实际操作 FIFO'
    };
  } catch (error) {
    payload.risk = { ok: false, error: error.message };
  }

  try {
    const { buildEventsDesk } = await import('./events.js');
    const events = await buildEventsDesk({ days: 10, refresh: true });
    payload.events = {
      ok: Boolean(events?.ok),
      upcoming: events?.counts?.upcoming ?? 0,
      earnings: events?.counts?.earnings ?? 0,
      expiries: events?.counts?.expiries ?? 0,
      error: events?.ok ? null : (events?.errors || [])
    };
  } catch (error) {
    payload.events = { ok: false, error: error.message };
  }

  try {
    const { buildGuardsDesk } = await import('./guards.js');
    const guards = await buildGuardsDesk();
    payload.guards = {
      ok: Boolean(guards?.ok),
      alerts: guards?.counts?.alerts ?? 0,
      missingStops: guards?.counts?.missingStops ?? 0,
      openOrders: guards?.counts?.openOrders ?? 0
    };
  } catch (error) {
    payload.guards = { ok: false, error: error.message };
  }

  try {
    let auto = null;
    if (opts.skipPaperAuto !== true) {
      auto = await runPaperOpen({
        date,
        recs: grokRecs?.error ? null : grokRecs
      });
    }
    const paperDesks = await listPaperViews();
    const sessions = auto?.sessions || {};
    const failedSessions = Object.values(sessions).filter((row) => row.ok === false);
    payload.paper = {
      ok: auto?.ok !== false,
      error: failedSessions.length ? failedSessions.map((row) => `${row.desk} ${row.note || '未完成'}`).join('；') : null,
      outsideSession: Boolean(auto?.outsideSession),
      stopFills: Object.values(auto?.stops || {}).flatMap((row) => (row.fills || []).filter((f) => f.ok && !f.replay).map((f) => `${row.desk}:${f.symbol}@${f.price}(${f.date})`)),
      auto: auto
        ? {
          note: auto.note,
          sessions: Object.fromEntries(Object.entries(sessions).map(([id, row]) => [id, {
            desk: row.desk,
            style: row.style,
            mode: row.mode,
            ok: row.ok !== false,
            fills: row.fills?.length ?? 0,
            skipped: row.skipped?.length ?? 0,
            note: row.note
          }]))
        }
        : { skipped: true },
      desks: Object.fromEntries(Object.entries(paperDesks).map(([id, row]) => [id, {
        nav: row?.ledger?.nav ?? null,
        cash: row?.ledger?.cash ?? null,
        positions: row?.ledger?.positions?.length ?? 0,
        fills: row?.ledger?.fills?.length ?? 0,
        mode: row?.mode || 'NORMAL'
      }])),
      note: '每日流水触发八本纸上账：0A–0F，以及 0G 小孟A股、0H 小孟美股。0E 有单腿参考合约就按 1 张小仓买。不是实盘，不写模拟操作。'
    };
  } catch (error) {
    payload.paper = { ok: false, error: error.message, note: '纸上实验失败，保留其他步骤结果并标记任务部分完成。' };
  }

  payload.calendarWarning = calendarWarning(date);
  payload.verify = await verifyDailyOutputs(date, { simDate });
  payload.completion = summarizeDailyJob(payload);
  payload.ok = payload.completion.ok;
  payload.status = payload.completion.status;

  await mkdir(REPORTS_DIR, { recursive: true });
  await mkdir(OBSIDIAN_DAILY, { recursive: true });
  const jobJson = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(join(REPORTS_DIR, `${date}-每日任务.json`), jobJson, 'utf8');
  await writeFile(join(OBSIDIAN_DAILY, `${date}-每日任务.json`), jobJson, 'utf8');
  return payload;
}
