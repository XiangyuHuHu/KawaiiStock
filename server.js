import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { PUBLIC_DIR, REPORTS_DIR, lastSessionStamp, logMissingPaths } from './src/paths.js';
import { buildDesk, buildTape, buildUniversePage } from './src/desk.js';
import { accountById, applyScan, canImportHoldings, importHoldings, loadAccounts, loadConfig, loadHoldings, loadStrategy, saveHoldings } from './src/holdings.js';
import { loadDailyReports, loadRecFiles } from './src/reports.js';
import { buildRecommendations } from './src/recommend.js';
import { buildCompare } from './src/compare.js';
import { appendActual, importBrokerFills, loadActualDay, loadActualFiles, recordAgenticFill, recordDailyActuals, removeActual } from './src/actuals.js';
import { writeAgenticNarrative } from './src/narrative.js';
import { getSimState, resetSim, runSimSettlement } from './src/sim.js';
import { runDailyJob } from './src/daily.js';
import { buildAccountPosters, buildSymbolPoster, posterPage, writePosters } from './src/posters.js';
import { buildTradableDesk, writeTradable } from './src/tradable.js';
import { checkOrder, getRiskView, setKill, setMode } from './src/risk/service.js';
import { getPaperView, listPaperViews, placePaperOrder, resetPaper } from './src/paper/desk.js';
import { runPaperOpen } from './src/paper/auto.js';
import { createMarketApiHandler } from './src/screener/market-data.mjs';

const marketApi = createMarketApiHandler();
let narrativeUpdate = null;
let dailyRun = null;

async function refreshAgenticBrief(date) {
  try {
    const { buildAndWriteAgenticBrief } = await import('./src/agentic-brief.js');
    await buildAndWriteAgenticBrief({ date });
  } catch {
    /* 意见刷新失败不挡住观察或推荐本身。 */
  }
}

const PORT = Number(process.env.PORT || 3479);
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';
  const path = normalize(join(PUBLIC_DIR, relative));
  if (!path.startsWith(PUBLIC_DIR)) {
    send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not file');
    send(res, 200, await readFile(path), TYPES[extname(path)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

async function resolveAccount(id, deskId = 'grok') {
  const config = await loadAccounts(deskId);
  const account = accountById(config, id);
  if (!account) return { config, account: null };
  return { config, account };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/strategy/validation') {
      try {
        const report = JSON.parse(await readFile(join(REPORTS_DIR, 'research', 'latest.json'), 'utf8'));
        const compact = ({ curve, tradeDetails, ...row }) => row;
        sendJson(res, 200, { ok: true, ...report, snapshotPath: undefined, results: report.results.map(compact), stress: compact(report.stress) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        sendJson(res, 200, { ok: true, empty: true, note: '尚未运行策略验证' });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const config = await loadConfig();
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        desks: config.desks.map((row) => row.id),
        accounts: config.desks.find((row) => row.id === 'grok')?.accounts.map((row) => row.id) || []
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      sendJson(res, 200, await loadAccounts(url.searchParams.get('desk') || 'grok'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/compare') {
      sendJson(res, 200, await buildCompare());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/desk') {
      sendJson(res, 200, await buildDesk(
        url.searchParams.get('account') || 'main',
        url.searchParams.get('desk') || 'grok'
      ));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tape') {
      const desk = await buildDesk(
        url.searchParams.get('account') || 'main',
        url.searchParams.get('desk') || 'grok'
      );
      sendJson(res, 200, await buildTape(desk));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stocks') {
      await marketApi(req, res, () => {});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/universe') {
      sendJson(res, 200, await buildUniversePage());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/reports') {
      sendJson(res, 200, await loadDailyReports());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reports/run') {
      narrativeUpdate ||= (async () => {
        const date = lastSessionStamp();
        const actual = await loadActualDay('grok', date);
        const report = await writeAgenticNarrative({
          date, preserveAuthored: true,
          fills: (actual.entries || []).filter((row) => row.accountId === 'agentic')
        });
        return { ok: true, liveTrading: false, report, reports: await loadDailyReports() };
      })().finally(() => { narrativeUpdate = null; });
      sendJson(res, 200, await narrativeUpdate);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/recommendations') {
      sendJson(res, 200, await loadRecFiles(url.searchParams.get('advisor') || url.searchParams.get('desk') || 'grok'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/recommendations/run') {
      const advisor = url.searchParams.get('advisor') || 'grok';
      const recs = await buildRecommendations({
        advisor,
        force: url.searchParams.get('force') === '1'
      });
      if (advisor === 'grok') await refreshAgenticBrief(recs?.date);
      sendJson(res, 200, recs);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/daily/run') {
      req.setTimeout(0);
      res.setTimeout(0);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      if (dailyRun) {
        sendJson(res, 409, { ok: false, busy: true, startedAt: dailyRun.startedAt, error: '一键更新已在运行，请等它结束' });
        return;
      }
      const job = runDailyJob({
        date: url.searchParams.get('date') || body.date,
        scans: body.scans || {},
        scanErrors: body.scanErrors || {},
        scanFailed: body.scanFailed || '',
        fills: body.fills || [],
        skipScan: body.skipScan !== false && !body.scans?.tactical && !body.scans?.agentic,
        forceRecs: url.searchParams.get('forceRecs') === '1' || body.forceRecs === true
      });
      dailyRun = { startedAt: new Date().toISOString(), job };
      try {
        const payload = await job;
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, payload);
      } catch (error) {
        if (!res.writableEnded && !res.destroyed) sendJson(res, 500, { ok: false, error: error.message });
      } finally {
        dailyRun = null;
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/actuals') {
      sendJson(res, 200, await loadActualFiles(url.searchParams.get('advisor') || url.searchParams.get('desk') || 'grok'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/actuals') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad-json' });
        return;
      }
      if (body.mode === 'agentic') {
        sendJson(res, 200, await recordAgenticFill(body));
        return;
      }
      if (body.mode === 'daily') {
        sendJson(res, 200, await recordDailyActuals(body));
        return;
      }
      if (body.mode === 'import') {
        sendJson(res, 200, await importBrokerFills(body.fills || [], {
          advisor: body.advisor || url.searchParams.get('advisor') || 'grok'
        }));
        return;
      }
      sendJson(res, 200, await appendActual({
        ...body,
        advisor: body.advisor || url.searchParams.get('advisor') || url.searchParams.get('desk') || 'grok'
      }, { source: 'manual' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/actuals/import') {
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const { loadScanFills } = await import('./src/actuals.js');
      const fills = Array.isArray(body.fills) && body.fills.length
        ? body.fills
        : await loadScanFills();
      sendJson(res, 200, await importBrokerFills(fills, {
        advisor: body.advisor || url.searchParams.get('advisor') || 'grok'
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/actuals/agentic') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad-json', message: 'JSON 无法解析。' });
        return;
      }
      sendJson(res, 200, await recordAgenticFill(body));
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/actuals') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      sendJson(res, 200, await removeActual({
        advisor: url.searchParams.get('advisor') || body.advisor || 'grok',
        date: url.searchParams.get('date') || body.date,
        id: url.searchParams.get('id') || body.id
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/posters') {
      const symbol = url.searchParams.get('symbol') || undefined;
      const pack = symbol
        ? await buildSymbolPoster({
          symbol,
          researchOnly: url.searchParams.get('view') === 'research',
          accountId: url.searchParams.get('account') || 'main',
          deskId: url.searchParams.get('desk') || 'grok'
        })
        : await buildAccountPosters({
          accountId: url.searchParams.get('account') || 'main',
          deskId: url.searchParams.get('desk') || 'grok'
        });
      sendJson(res, pack.ok ? 200 : 400, pack);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/posters/html') {
      const pack = await buildAccountPosters({
        accountId: url.searchParams.get('account') || 'main',
        deskId: url.searchParams.get('desk') || 'grok',
        symbol: url.searchParams.get('symbol')
      });
      const card = (pack.cards || []).find((row) => row.ok) || pack.cards?.[0];
      send(res, pack.ok && card ? 200 : 400, card ? posterPage(card) : JSON.stringify(pack), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tradable') {
      const pack = await buildTradableDesk({
        date: url.searchParams.get('date') || undefined,
        deskId: url.searchParams.get('desk') || 'grok'
      });
      sendJson(res, pack.ok ? 200 : 400, pack);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tradable/run') {
      const pack = await buildTradableDesk({
        date: url.searchParams.get('date') || undefined,
        deskId: url.searchParams.get('desk') || 'grok'
      });
      if (!pack.ok) {
        sendJson(res, 400, pack);
        return;
      }
      pack.written = await writeTradable(pack);
      sendJson(res, 200, pack);
      return;
    }
    if (['GET','POST'].includes(req.method) && url.pathname === '/api/oracle/accuracy') {
      const { oracleAccuracy,chinaOracleAccuracy } = await import('./src/oracle/accuracy.js');
      const { buildSymbolOracle,validOracleDay } = await import('./src/oracle/symbols.js');
      const date=url.searchParams.get('date')||undefined;
      const market=url.searchParams.get('market')||'us';
      if(!['us','cn'].includes(market)){sendJson(res,400,{ok:false,error:'市场无效'});return;}
      if(date&&!validOracleDay(date)) {sendJson(res,400,{ok:false,error:'观察日无效'});return;}
      const store=market==='cn'?chinaOracleAccuracy:oracleAccuracy;
      const result=req.method==='POST'?await store.refresh(await buildSymbolOracle({date,market})):await store.read({date});
      sendJson(res,200,result);return;
    }
    if (req.method === 'GET' && url.pathname === '/api/oracle/symbols') {
      const { buildSymbolOracle, validOracleDay } = await import('./src/oracle/symbols.js');
      const date = url.searchParams.get('date') || undefined;
      const market=url.searchParams.get('market')||'us';
      if(!['us','cn'].includes(market)){sendJson(res,400,{ok:false,error:'市场无效'});return;}
      if(date && !validOracleDay(date)) { sendJson(res,400,{ok:false,error:'观察日无效'}); return; }
      sendJson(res,200,await buildSymbolOracle({date,market}));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/oracle/current') {
      const { buildCurrentQimen } = await import('./src/oracle/qimen-current.js');
      const scope = url.searchParams.get('scope') || 'all';
      if (!['all','us','cn'].includes(scope)) { sendJson(res,400,{ok:false,error:'奇门范围无效'});return; }
      sendJson(res,200,await buildCurrentQimen({scope}));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/oracle') {
      const { buildOracleDesk } = await import('./src/oracle/qimen.js');
      sendJson(res, 200, await buildOracleDesk({ date: url.searchParams.get('date') || undefined, refresh: url.searchParams.get('refresh') === '1' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/oracle/write') {
      const { ensureOracleWrite } = await import('./src/oracle/qimen.js');
      const body = await readJsonBody(req).catch(() => ({}));
      const pack = await ensureOracleWrite({ date: body.date || url.searchParams.get('date') || undefined });
      if (pack.empty) {
        sendJson(res, 400, pack);
        return;
      }
      sendJson(res, 200, pack);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/agentic-brief') {
      const { loadAgenticBriefWithFreshness, buildAndWriteAgenticBrief } = await import('./src/agentic-brief.js');
      let pack = await loadAgenticBriefWithFreshness(url.searchParams.get('date') || undefined);
      if (pack?.upstreamStale) {
        pack = await buildAndWriteAgenticBrief({ date: pack.date });
        pack = { ...pack, regeneratedBecause: 'upstream-newer' };
      }
      sendJson(res, 200, pack || { ok: false, empty: true, note: '还没有 Agentic 操作意见。每日任务会写；也可点刷新。不是下单。' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agentic-brief/run') {
      const { buildAndWriteAgenticBrief } = await import('./src/agentic-brief.js');
      const body = await readJsonBody(req).catch(() => ({}));
      sendJson(res, 200, await buildAndWriteAgenticBrief({ date: body.date || url.searchParams.get('date') || undefined }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/posters/run') {
      const pack = await buildAccountPosters({
        accountId: url.searchParams.get('account') || url.searchParams.get('accountId') || 'main',
        deskId: url.searchParams.get('desk') || 'grok'
      });
      if (!pack.ok) {
        sendJson(res, 400, pack);
        return;
      }
      pack.written = await writePosters(pack);
      sendJson(res, 200, pack);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/risk') {
      sendJson(res, 200, await getRiskView(url.searchParams.get('book') || 'live'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/risk/check') {
      const body = await readJsonBody(req);
      const result = await checkOrder(body);
      sendJson(res, result.decision.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/risk/mode') {
      const body = await readJsonBody(req);
      const result = await setMode(body.book || body.desk || 'live', body.mode, {
        reason: body.reason,
        confirm: body.confirm === true,
        actor: body.actor || 'human'
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/risk/kill') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await setKill(body.reason || 'manual', body.on !== false, {
        confirm: body.confirm === true,
        actor: body.actor || 'human'
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/guards') {
      const { buildGuardsDesk } = await import('./src/guards.js');
      sendJson(res, 200, await buildGuardsDesk());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/review') {
      const { buildReviewDesk } = await import('./src/review.js');
      sendJson(res, 200, await buildReviewDesk({
        advisor: url.searchParams.get('advisor') || url.searchParams.get('desk') || 'grok',
        limit: url.searchParams.get('limit') || 16
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { buildEventsDesk } = await import('./src/events.js');
      sendJson(res, 200, await buildEventsDesk({
        days: Number(url.searchParams.get('days') || 10),
        refresh: url.searchParams.get('refresh') === '1'
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/watchlist/cn') {
      const { loadCnWatchlist, buildAndWriteCnWatchlist } = await import('./src/strategy/watchlist-cn.js');
      const date = url.searchParams.get('date');
      if (url.searchParams.get('refresh') === '1') {
        sendJson(res, 200, await buildAndWriteCnWatchlist({ date }));
        return;
      }
      const pack = await loadCnWatchlist(date, { auto: false });
      sendJson(res, 200, pack || { ok: false, empty: true, market: 'cn', note: '还没有 A 股每日观察。' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/watchlist/cn/run') {
      const { buildAndWriteCnWatchlist } = await import('./src/strategy/watchlist-cn.js');
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      sendJson(res, 200, await buildAndWriteCnWatchlist({ date: body.date || url.searchParams.get('date') }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/watchlist') {
      const { loadWatchlist, buildAndWriteWatchlist } = await import('./src/strategy/watchlist.js');
      const date = url.searchParams.get('date');
      if (url.searchParams.get('refresh') === '1') {
        const pack = await buildAndWriteWatchlist({ date });
        await refreshAgenticBrief(pack?.date || date);
        sendJson(res, 200, pack);
        return;
      }
      const pack = await loadWatchlist(date, { auto: false });
      sendJson(res, 200, pack || { ok: false, empty: true, note: '今日还没有每日观察。点扫描生成。缺文件不让每日任务失败。' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/watchlist/run') {
      const { buildAndWriteWatchlist } = await import('./src/strategy/watchlist.js');
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const pack = await buildAndWriteWatchlist({ date: body.date || url.searchParams.get('date') });
      await refreshAgenticBrief(pack?.date);
      sendJson(res, 200, pack);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/watch-score') {
      const { loadWatchScore, updateWatchScore } = await import('./src/strategy/watch-score.js');
      if (url.searchParams.get('refresh') === '1') {
        sendJson(res, 200, await updateWatchScore({ asOf: url.searchParams.get('date') || undefined }));
        return;
      }
      sendJson(res, 200, await loadWatchScore() || { ok: false, empty: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/cycle') {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      if (!symbol) {
        sendJson(res, 400, { ok: false, error: 'missing-symbol' });
        return;
      }
      const { loadOneCycle } = await import('./src/strategy/cycle.js');
      const { loadWatchScore, lookupStageRate, formatWinRate } = await import('./src/strategy/watch-score.js');
      const cycle = await loadOneCycle(symbol);
      const score = await loadWatchScore();
      const winRate = lookupStageRate(score, cycle.stage);
      const versionRate = cycle.version ? score?.locked?.byVersion?.[cycle.version]?.byStage?.[cycle.stage] : null;
      sendJson(res, 200, {
        ...cycle,
        winRate: winRate?.n
          ? { rate: winRate.rate, hits: winRate.hits, n: winRate.n, usefulRate: winRate.usefulRate }
          : null,
        winRateLabel: formatWinRate(winRate),
        winRateScope: '历史精选候选，包含不同策略版本',
        versionWinRate: versionRate || null
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/paper') {
      if (url.searchParams.get('all') === '1') {
        sendJson(res, 200, { ok: true, desks: await listPaperViews() });
        return;
      }
      sendJson(res, 200, await getPaperView(url.searchParams.get('desk') || '0b'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/paper/order') {
      const body = await readJsonBody(req);
      const result = await placePaperOrder({
        ...body,
        desk: body.desk || url.searchParams.get('desk') || '0b'
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/paper/auto') {
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const { buildRecommendations } = await import('./src/recommend.js');
      let recs = null;
      try { recs = await buildRecommendations({ advisor: 'grok' }); } catch { recs = null; }
      const result = await runPaperOpen({
        date: url.searchParams.get('date') || body.date,
        recs,
        desk: body.desk || url.searchParams.get('desk') || 'all',
        force: body.force === true
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/paper/reset') {
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      sendJson(res, 200, await resetPaper(body.desk || url.searchParams.get('desk') || '0b'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sim') {
      sendJson(res, 200, await getSimState(url.searchParams.get('account') || 'all'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sim/run') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      sendJson(res, 200, await runSimSettlement({
        date: url.searchParams.get('date') || body.date,
        dryRun: url.searchParams.get('dryRun') === '1' || body.dryRun === true
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sim/reset') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      sendJson(res, 200, await resetSim({
        book: url.searchParams.get('book') || body.book || 'all'
      }));
      return;
    }
    const deskId = url.searchParams.get('desk') || 'grok';
    const holdingsMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/holdings$/);
    if (holdingsMatch) {
      const { config, account } = await resolveAccount(holdingsMatch[1], deskId);
      if (!account) {
        sendJson(res, 404, { error: 'unknown-account' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, await loadHoldings(account));
        return;
      }
      if (req.method === 'PUT') {
        if (!config.desk?.writable) {
          sendJson(res, 400, { error: 'readonly-desk', message: 'ChatGPT 台只读，不能改持仓。' });
          return;
        }
        if (account.source !== 'manual') {
          sendJson(res, 400, { error: 'use-scan', message: '小账户请走扫描接口。' });
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, await saveHoldings(account, body));
        return;
      }
    }
    const scanMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/scan$/);
    if (req.method === 'POST' && scanMatch) {
      const { config, account } = await resolveAccount(scanMatch[1], deskId);
      if (!account) {
        sendJson(res, 404, { error: 'unknown-account' });
        return;
      }
      if (!config.desk?.writable) {
        sendJson(res, 400, { error: 'readonly-desk', message: 'ChatGPT 台只读，不能覆盖持仓。' });
        return;
      }
      const body = await readJsonBody(req);
      sendJson(res, 200, await applyScan(account, body));
      return;
    }
    const importMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/holdings\/import$/);
    if (req.method === 'POST' && importMatch) {
      const { config, account } = await resolveAccount(importMatch[1], deskId);
      if (!account) {
        sendJson(res, 404, { error: 'unknown-account' });
        return;
      }
      if (!config.desk?.writable) {
        sendJson(res, 400, { error: 'readonly-desk', message: 'ChatGPT 台只读，不能导入持仓。' });
        return;
      }
      if (!canImportHoldings(account)) {
        sendJson(res, 400, { error: 'use-manual', message: '主账户请用手改。Agentic 可以导入持仓 JSON，不会下单。' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const book = await importHoldings(account, body);
        sendJson(res, 200, { ...book, liveTrading: false, imported: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message, liveTrading: false });
      }
      return;
    }
    const strategyMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/strategy$/);
    if (req.method === 'GET' && strategyMatch) {
      const { config, account } = await resolveAccount(strategyMatch[1], deskId);
      if (!account) {
        sendJson(res, 404, { error: 'unknown-account' });
        return;
      }
      sendJson(res, 200, await loadStrategy(account, config.desk));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.requestTimeout = 180000;
server.timeout = 180000;
server.listen(PORT, HOST, () => {
  console.log(`Kawaii Research Desk  http://${HOST}:${PORT}`);
  logMissingPaths().catch((error) => console.error(`路径检查失败：${error.message}`));
});
