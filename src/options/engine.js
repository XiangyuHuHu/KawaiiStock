import { chooseUnderlyingQuote, sourceDiagnostics } from './sources.js';
import { archiveOptions } from './history.js';
import { regularSession } from './time.js';
import { closedBars } from '../market-time.js';
import { randomUUID } from 'node:crypto';
import { MODEL_VERSION } from './contracts.js';
import { reassessOptions } from './safety.js';
import { recordForward } from './forward.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_OPTIONS, todayStamp } from '../paths.js';
import { loadAccounts, loadHoldings } from '../holdings.js';
import { loadHistoricals } from '../historicals.js';
import { freshnessFromContext } from '../risk/freshness.js';
import { getStrategy, listStrategies } from './strategies.js';
import { clearMarketCache, loadEarnings, loadBestChain, loadChart, loadExpirationChain, loadSentiment, loadVix, loadYahooQuote, mapPool, pickUnderlyingQuoteAt } from './market.js';
import { attachOptionScore, updateOptionScore } from './score.js';

export { listStrategies };

const SCAN_CAP = 16;
const BUY_CAP = 3;
const scans = new Map();
export function rememberScan(pack) {
  for (const [key, entry] of scans) if (Date.now() - entry.at > 1800000) scans.delete(key);
  while (scans.size >= 10) scans.delete(scans.keys().next().value);
  scans.set(pack.scanId, { pack: structuredClone(pack), at: Date.now(), saving: null });
  return pack;
}
export async function saveOptionsScan(scanId) {
  const entry = scans.get(scanId);
  if (!entry || Date.now() - entry.at > 1800000) return { ok: false, error: '扫描已失效或服务重启，请重新扫描后保存' };
  if (!entry.saving) entry.saving = writeOptions(structuredClone(entry.pack)).catch(error => { entry.saving = null; throw error; });
  return { ok: true, scanId, written: await entry.saving };
}

function isEquitySymbol(symbol) {
  return /^[A-Z][A-Z.]{0,4}$/.test(String(symbol || '').toUpperCase());
}

function isLeveredName(name = '') {
  return /2x|Ultra|Direxion|ProShares|Leveraged/i.test(name);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function optionUniverse({ deskId = 'grok', full = false } = {}) {
  const config = await loadAccounts(deskId);
  const seen = new Set();
  const rows = [];
  for (const account of config.accounts || []) {
    if (account.id === 'main') continue;
    const book = await loadHoldings(account);
    for (const pos of book.positions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!isEquitySymbol(symbol) || seen.has(symbol) || isLeveredName(pos.name)) continue;
      seen.add(symbol);
      rows.push({ symbol, name: pos.name || symbol, from: 'holdings', accountId: account.id });
    }
    for (const pos of book.optionPositions || []) {
      const symbol = String(pos.symbol || '').toUpperCase();
      if (!isEquitySymbol(symbol) || seen.has(symbol)) continue;
      seen.add(symbol);
      rows.push({ symbol, name: symbol, from: 'option-holding', accountId: account.id });
    }
  }
  for (const symbol of config.focusTape || []) {
    const key = String(symbol || '').toUpperCase();
    if (!isEquitySymbol(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push({ symbol: key, name: key, from: 'tape', accountId: 'watch' });
  }
  return full ? rows : rows.slice(0, SCAN_CAP);
}

async function loadContext(row, asOf) {
  const [intra60, daily, chainRaw, sentiment, quote] = await Promise.all([
    loadChart(row.symbol, { range: '10d', interval: '5m' }),
    loadHistoricals(row.symbol),
    loadBestChain(row.symbol),
    loadSentiment(row.symbol),
    loadYahooQuote(row.symbol)
  ]);
  let intra = intra60;
  if (!intra.ok || (intra.bars || []).length < 80) {
    intra = await loadChart(row.symbol, { range: '5d', interval: '5m' });
  }
  const chain = { ...chainRaw, earnings: await loadEarnings(row.symbol, chainRaw, quote) };
  const paired = chooseUnderlyingQuote(chainRaw, quote, intra);
  const last = paired.last || daily.bars?.at(-1)?.close || null;
  const fetchedAt = intra.fetchedAt || chain.fetchedAt || quote.fetchedAt || Date.now();
  return {
    symbol: row.symbol,
    name: row.name,
    from: row.from,
    accountId: row.accountId,
    asOf,
    last,
    fetchedAt,
    quoteAt: paired.quoteAt,
    quoteSource: paired.source,
    intra: intra.ok ? intra.bars.filter(bar => bar.ts > 0 && bar.ts + 300000 <= Date.now() && regularSession(bar.ts)) : [],
    daily: daily.ok ? closedBars(daily.bars) : [],
    chain,
    sentiment,
    errors: {
      intra: intra.ok ? null : intra.error,
      daily: daily.ok ? null : daily.error,
      chain: chain.ok ? null : chain.error
    }
  };
}

function rankRow(row) {
  const buy = ['BUY_CALL', 'BUY_PUT', 'CALL_SPREAD', 'PUT_SPREAD', 'STRADDLE'].includes(row.action) ? 0 : 1;
  const ev = row.optionEv == null ? -9 : row.optionEv;
  const efficiency = row.costs?.maxLoss > 0 && row.evEstimate?.perGroup != null ? row.evEstimate.perGroup / row.costs.maxLoss : -999;
  return [buy, -efficiency, -ev, -(row.cov || 0)];
}

function cmpRank(a, b) {
  const aa = rankRow(a);
  const bb = rankRow(b);
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return String(a.symbol).localeCompare(String(b.symbol));
}

function isBuy(action) {
  return ['BUY_CALL', 'BUY_PUT', 'CALL_SPREAD', 'PUT_SPREAD', 'STRADDLE'].includes(action);
}

// Robinhood 期权佣金为 0，只剩监管/交易所杂费，按每张每次约 $0.03 估。
export const DEFAULT_FEE_PER_CONTRACT = 0.03;

export async function buildOptionsDesk({ date, strategyId = 'cov', deskId = 'grok', feePerContract = DEFAULT_FEE_PER_CONTRACT, refresh = false } = {}) {
  if (refresh) clearMarketCache();
  const day = date || todayStamp();
  const strategy = getStrategy(strategyId);
  const fullUniverse = await optionUniverse({ deskId, full: true });
  const universe = fullUniverse.slice(0, SCAN_CAP);
  const vix = await loadVix();
  const contexts = await mapPool(universe, (row) => loadContext(row, day), { concurrency: 3 });
  const ideas = [];
  for (const ctx of contexts) {
    try {
      const signal = strategy.evaluate({ ...ctx, vix, feePerContract });
      const freshness = freshnessFromContext(ctx);
      ideas.push({
        ...signal,
        name: ctx.name,
        from: ctx.from,
        accountId: ctx.accountId,
        dataErrors: ctx.errors,
        sourceDiagnostics: sourceDiagnostics(ctx),
        providerError: ctx.chain?.providerError || null,
        earnings: ctx.chain?.earnings,
        sourceTimes: { quoteAt: ctx.quoteAt ?? null, quoteSource: ctx.quoteSource || null, intraLastTs: ctx.intra.at(-1)?.ts ?? null, fetchedAt: ctx.fetchedAt },
        freshness
      });
    } catch (error) {
      ideas.push({
        symbol: ctx.symbol,
        name: ctx.name,
        strategyId: strategy.id,
        action: 'NO_TRADE',
        reason: `计算失败：${error.message}`,
        cov: 0,
        tempting: false
      });
    }
  }
  ideas.sort(cmpRank);

  const buys = [];
  for (const row of ideas) {
    if (!isBuy(row.action) || !row.contract) continue;
    if (!(row.optionEv > 0)) continue;
    if ((row.patternMatches || 0) < 20) continue;
    if (buys.length >= BUY_CAP) break;
    buys.push(row);
  }
  const buySet = new Set(buys.map((row) => row.symbol));
  const skipped = ideas.filter((row) => !buySet.has(row.symbol));
  const tempting = skipped.filter((row) => row.tempting);

  return rememberScan(reassessOptions({
    ok: true,
    scanId: randomUUID(), modelVersion: MODEL_VERSION,
    costAssumptions: { feePerContract },
    coverage: { total: fullUniverse.length, scanned: universe.length, unscanned: fullUniverse.slice(SCAN_CAP).map(r => r.symbol), cap: SCAN_CAP },
    liveTrading: false,
    draft: true,
    date: day,
    generatedAt: new Date().toISOString(),
    strategy: {
      id: strategy.id,
      name: strategy.name,
      summary: strategy.summary
    },
    strategies: listStrategies(),
    vix: vix.ok ? vix.last : null,
    note: '草稿，不是下单指令。不写进推荐操作 / 模拟操作 / 实际操作。主账户不做期权。最多 0–3 个买入候选；Yahoo/Nasdaq 若缺每腿 Bid/Ask 时间则不能进买入。没有优势就 NO TRADE。',
    scanned: universe.length,
    ideas,
    buys,
    tempting,
    skipped,
    counts: {
      buy: buys.length,
      tempting: tempting.length,
      noTrade: skipped.filter((row) => row.action === 'NO_TRADE').length,
      scanned: ideas.length
    }
  }));
}

function money(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function leanOf(row) {
  return row.lean || (row.direction === 'up' ? '看涨' : row.direction === 'down' ? '看跌' : '方向不明');
}

function kindOf(row) {
  if (row.kind) return row.kind;
  const type = row.contract?.type;
  if (type === 'put') return 'Put';
  if (type === 'call') return 'Call';
  if (type === 'straddle') return 'Straddle';
  return '—';
}

function expOf(row) {
  const value = row.contract?.expiration;
  return value ? String(value).replaceAll('-', '/') : '—';
}

function strikeOf(row) {
  const c = row.contract;
  if (!c) return '—';
  if (c.type === 'straddle') return `$${c.callStrike}/${c.putStrike}`;
  if (c.shortStrike) return `$${c.strike}/${c.shortStrike}`;
  return c.strike == null ? '—' : `$${c.strike}`;
}

function bidAsk(row) {
  return `${money(row.contract?.bid)} / ${money(row.contract?.ask)}`;
}

function freshOf(row) {
  return row.freshness?.label || (row.staleBlocked ? '不新鲜' : '—');
}

function verdictOf(row) {
  if (row.eligible) return row.action;
  const original = row.originalAction || row.action;
  if (original && original !== 'NO_TRADE') return `${original}（未通过校验）`;
  return 'NO_TRADE';
}

export function renderOptionsMarkdown(pack) {
  const buyRows = (pack.buys || []).map((row, i) => (
    `| ${i + 1} | ${row.symbol} | ${leanOf(row)} | ${kindOf(row)} | ${expOf(row)} | ${strikeOf(row)} | ${bidAsk(row)} | ${row.cov?.toFixed?.(0) ?? '—'} | ${row.optionEvLabel} | ${freshOf(row)} | ${row.reason} |`
  )).join('\n');
  const skipRows = (pack.tempting || []).map((row) => (
    `| ${row.symbol} | ${leanOf(row)} | ${kindOf(row)} | ${expOf(row)} | ${strikeOf(row)} | ${bidAsk(row)} | ${row.cov?.toFixed?.(0) ?? '—'} | ${row.optionEvLabel || '—'} | ${freshOf(row)} | ${row.reason}${row.alternative ? `；${row.alternative}` : ''} |`
  )).join('\n');
  const scanRows = (pack.ideas || []).map((row) => (
    `| ${row.symbol} | ${verdictOf(row)} | ${leanOf(row)} | ${kindOf(row)} | ${expOf(row)} | ${strikeOf(row)} | ${bidAsk(row)} | ${row.cov?.toFixed?.(0) ?? '—'} | ${row.optionEvLabel || '—'} | ${freshOf(row)} | ${row.reason} |`
  )).join('\n');
  const detailBlock = (row, role) => `
## ${row.headline || `${row.symbol} · ${leanOf(row)}`}

- ${role}
- Call/Put：${kindOf(row)}
- 到期：${expOf(row)}
- 行权价：${strikeOf(row)}
- Bid / Ask：${bidAsk(row)}
- 数据：${freshOf(row)}
- 现价：${money(row.last)}
- IV：${row.contract?.iv != null ? `${(row.contract.iv * 100).toFixed(1)}%` : (row.ivAtm != null ? `${(row.ivAtm * 100).toFixed(1)}%` : '—')}
- Delta：${row.contract?.delta != null ? row.contract.delta.toFixed(3) : '—'}
- COV：${row.cov} · Direction ${row.directionalScore} · Vol ${row.volatilityScore}
- 样本：${row.patternMatches} · 视界 ${row.horizon}
- Option EV：${row.optionEvLabel}${row.optionEv != null ? `（每股 ${row.optionEv.toFixed(3)}）` : ''}
- 入场：${row.entry}
- 最大风险：$${money(row.maxRisk)} / 组（含预留双程费）
- 止损：${money(row.stop)} · 第一止盈 ${money(row.takeProfit1)} · 第二止盈 ${money(row.takeProfit2)}
- ${row.reason}
${(row.notes || []).map((line) => `- ${line}`).join('\n')}
`;
  const details = (pack.buys || []).map((row) => detailBlock(row, '可研究候选（只读，不是下单）')).join('\n');
  const skipDetails = (pack.tempting || []).map((row) => detailBlock(row, '参考合约，今日不买')).join('\n');

  return `---
title: 期权推荐
date: ${pack.date}
type: option-recommendation
strategy: ${pack.strategy?.id || 'cov'}
liveTrading: false
draft: true
---

# ${pack.date} 期权推荐（${pack.strategy?.name || 'COV'}）

> ${pack.note}
> 策略：${pack.strategy?.summary || ''}
> 扫描 ${pack.scanned} 只 · VIX ${pack.vix ?? '—'}

## 今日最佳期权机会

| # | 代码 | 看向 | Call/Put | 到期 | 行权价 | Bid / Ask | COV | EV | 数据 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
${buyRows || '| — |  |  |  |  |  |  |  |  | 今日无值得买入的期权 |'}

## 看起来很诱人，但今天不要买

| 代码 | 看向 | Call/Put | 到期 | 行权价 | Bid / Ask | COV | EV | 数据 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
${skipRows || '| — |  |  |  |  |  |  |  | 今日没有「看起来诱人但不买」的标的 |'}

## 本次扫描

| 代码 | 判定 | 看向 | Call/Put | 到期 | 行权价 | Bid / Ask | COV | EV | 数据 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
${scanRows || '| — |  |  |  |  |  |  |  |  | 还没扫描 |'}

${details || '## 无买入候选\n\n今日无值得买入的期权 / NO TRADE。'}

${skipDetails ? `## 诱人但不买 · 参考合约\n${skipDetails}` : ''}
`;
}

function slim(row) {
  const copy = { ...row };
  delete copy.components;
  return {
    ...copy,
    components: row.components
      ? Object.fromEntries(Object.entries(row.components).map(([k, v]) => [k, { score: v.score, note: v.note, label: v.label }]))
      : null
  };
}

let writeQueue = Promise.resolve();
export function writeOptions(pack) {
  const run = writeQueue.then(() => persistOptions(pack));
  writeQueue = run.catch(() => {});
  return run;
}

async function persistOptions(pack) {
  await mkdir(OBSIDIAN_OPTIONS, { recursive: true });
  const slimPack = {
    ...pack,
    ideas: (pack.ideas || []).map(slim),
    buys: (pack.buys || []).map(slim),
    tempting: (pack.tempting || []).map(slim),
    skipped: (pack.skipped || []).map(slim)
  };
  const stem = `${pack.date}-${pack.strategy?.id || 'cov'}`;
  const previous = await readJson(join(OBSIDIAN_OPTIONS, `${stem}.json`));
  if (previous) await archiveOptions(previous);
  await archiveOptions(slimPack);
  if (pack.scanId) await recordForward(pack);
  await writeFile(join(OBSIDIAN_OPTIONS, `${stem}.json`), `${JSON.stringify(slimPack, null, 2)}\n`, 'utf8');
  await writeFile(join(OBSIDIAN_OPTIONS, `${stem}.md`), `${renderOptionsMarkdown(pack)}\n`, 'utf8');
  try {
    pack.score = await updateOptionScore({ asOf: pack.date });
  } catch (error) {
    pack.score = { ok: false, error: error.message };
  }
  return { dir: OBSIDIAN_OPTIONS, date: pack.date, strategy: pack.strategy?.id, count: pack.buys.length, file: stem };
}

function sameLeg(left, right) {
  return left?.type === right?.type
    && left?.expiration === right?.expiration
    && Number(left?.strike) > 0
    && Number(left.strike) === Number(right?.strike);
}

/** Re-read Bid/Ask for the contracts already on screen. Does not write a scan or invent a quote timestamp. */
export async function refreshDisplayedQuotes(pack, { maxAgeMs = 45000, loader } = {}) {
  const ideas = (pack?.ideas || []).map((row) => ({
    ...row,
    contract: row.contract
      ? { ...row.contract, legs: (row.contract.legs || []).map((leg) => ({ ...leg })) }
      : row.contract,
    sourceTimes: { ...(row.sourceTimes || {}) }
  }));
  const groups = new Map();
  for (const row of ideas) {
    const expiration = row.contract?.legs?.[0]?.expiration || row.contract?.expiration;
    if (!row.symbol || !expiration) continue;
    const key = `${String(row.symbol).toUpperCase()}|${expiration}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const quoteRefreshErrors = [];
  await mapPool([...groups.entries()], async ([key, rows]) => {
    const [symbol, expiration] = key.split('|');
    let chain;
    try {
      chain = await loadExpirationChain(symbol, expiration, { maxAgeMs, ...(loader ? { loader } : {}) });
    } catch (error) {
      quoteRefreshErrors.push(`${symbol} ${expiration}：${error.message}`);
      return;
    }
    const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
    if (!legs.length) {
      quoteRefreshErrors.push(`${symbol} ${expiration}：${chain?.error || '没有这张到期日的合约'}`);
      return;
    }
    for (const row of rows) {
      let patched = 0;
      for (const leg of row.contract?.legs || []) {
        const hit = legs.find((item) => sameLeg(leg, item));
        if (!hit || !(Number(hit.bid) > 0) || !(Number(hit.ask) >= Number(hit.bid))) continue;
        leg.bid = hit.bid;
        leg.ask = hit.ask;
        if (hit.last != null) leg.last = hit.last;
        leg.mid = hit.mid ?? (Number(hit.bid) + Number(hit.ask)) / 2;
        if (hit.volume != null) leg.volume = hit.volume;
        if (hit.openInterest != null) leg.openInterest = hit.openInterest;
        if (hit.iv != null) leg.iv = hit.iv;
        if (hit.lastTradeAt != null) leg.lastTradeAt = hit.lastTradeAt;
        if (Number(hit.quoteAt) > 0) leg.quoteAt = hit.quoteAt;
        patched += 1;
      }
      if (Number(chain.last) > 0 && Number(chain.underlyingQuoteAt) > 0) {
        row.last = chain.last;
        row.sourceTimes.quoteAt = chain.underlyingQuoteAt;
        row.sourceTimes.quoteSource = chain.underlyingSource || chain.source || row.sourceTimes.quoteSource;
      }
      row.quotePatch = patched;
    }
  }, { concurrency: 3 });
  const next = reassessOptions({ ...pack, ideas });
  return {
    ...next,
    liveQuotes: true,
    quotesRefreshedAt: new Date().toISOString(),
    quoteRefreshErrors
  };
}

export async function loadOptionsFile(date, strategyId = 'cov') {
  const day = date || todayStamp();
  const exact = (await readJson(join(OBSIDIAN_OPTIONS, `${day}-${strategyId}.json`)))
    || (await readJson(join(OBSIDIAN_OPTIONS, `${day}.json`)));
  if (exact) return attachOptionScore(reassessOptions(exact));
  if (date) return null;
  try {
    const names = await readdir(OBSIDIAN_OPTIONS);
    const suffix = `-${strategyId}.json`;
    const dates = names
      .filter((name) => name.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}/.test(name))
      .map((name) => name.slice(0, 10))
      .sort()
      .reverse();
    for (const older of dates) {
      const pack = await readJson(join(OBSIDIAN_OPTIONS, `${older}-${strategyId}.json`));
      if (!pack) continue;
      return attachOptionScore(reassessOptions({
        ...pack,
        stale: true,
        requestedDate: day,
        note: `今日 ${day} 还没有扫描，显示最近一次 ${pack.date || older}。点「扫描」会拉今日数据。`
      }));
    }
  } catch {
    return null;
  }
  return null;
}
