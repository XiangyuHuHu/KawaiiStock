import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lastSessionStamp, OBSIDIAN_WATCH, REPORTS_DIR, todayStamp } from '../paths.js';
import { loadQuotes } from '../quotes.js';
import { loadUniverse } from '../universe.js';
import { loadHistoricals } from '../historicals.js';
import { computeLevels } from '../levels.js';
import { closedBars } from '../market-time.js';
import { loadCycleBook, CYCLE_NAME } from './cycle.js';
import { attachWatchScore, formatWinRate, lookupStageRate, updateWatchScore } from './watch-score.js';
import { universeSnapshot, saveUniverseSnapshot } from './watch-universe-score.js';

const MAX = { confluence: 4, setups: 4, volume: 3, rs: 4, avoid: 4, featured: 3 };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function card(symbol, meta, cycle, quote) {
  const feeds = [];
  if (cycle?.allowNewLong || cycle?.watch) feeds.push('cycle');
  if (cycle?.rs20 != null && cycle.rs20 > 0) feeds.push('rs');
  if (cycle?.volumeRatio != null && cycle.volumeRatio >= 1.5) feeds.push('volume');
  if (cycle?.stage === 'wedge-drop' || cycle?.stage === 'exhaustion-extension') feeds.push('avoid');
  return {
    symbol,
    lists: meta.lists || [],
    version: cycle?.version,
    signalDate: cycle?.signalDate,
    confirmation: cycle?.confirmation,
    riskPlan: cycle?.riskPlan,
    quoteAt: quote?.quoteAt ?? null,
    priceDate: quote?.ok
      ? (Number.isFinite(quote.quoteAt) && quote.quoteAt > 0 ? todayStamp(new Date(quote.quoteAt)) : null)
      : cycle?.signalDate || null,
    buckets: meta.buckets || [],
    last: quote?.ok ? quote.last : cycle?.last ?? null,
    changePct: quote?.ok ? quote.changePct : null,
    stage: cycle?.stage || 'unknown',
    stageLabel: cycle?.stageLabel || 'DATA UNAVAILABLE',
    score: cycle?.score ?? null,
    allowNewLong: Boolean(cycle?.allowNewLong),
    watch: Boolean(cycle?.watch),
    regime: cycle?.regime || 'unknown',
    rs20: cycle?.rs20 ?? null,
    volumeRatio: cycle?.volumeRatio ?? null,
    stop: cycle?.stop ?? null,
    atr: cycle?.atr ?? null,
    atrPct: cycle?.atrPct ?? null,
    confidence: cycle?.confidence ?? null,
    note: cycle?.note || 'DATA UNAVAILABLE',
    feeds
  };
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Number(Number(n).toFixed(2));
}

function pctOf(part, whole) {
  if (!(whole > 0) || part == null) return null;
  return Number(((part / whole) * 100).toFixed(2));
}

function realizedVol(bars, n = 20) {
  if (!bars?.length || bars.length < n + 1) return null;
  const rets = [];
  for (let i = bars.length - n; i < bars.length; i += 1) {
    const a = bars[i]?.close;
    const b = bars[i - 1]?.close;
    if (a > 0 && b > 0) rets.push(Math.log(a / b));
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  if (!(variance > 0)) return null;
  return Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(1));
}

function upsideRank(row) {
  if (!row?.last || row.score == null) return -999;
  if (row.stage === 'wedge-drop' || row.stage === 'reversal-extension') return -999;
  let rank = row.score;
  if (row.allowNewLong) rank += 22;
  else if (row.watch) rank += 6;
  if (['wedge-pop', 'ema-crossback', 'base-n-break'].includes(row.stage)) rank += 10;
  if (row.stage === 'exhaustion-extension') rank -= 25;
  if (row.rs20 != null) rank += Math.max(-8, Math.min(16, row.rs20));
  if (row.volumeRatio >= 1.5) rank += 6;
  if (row.changePct != null && row.changePct >= 12) rank -= 8;
  return rank;
}

function downsideRank(row) {
  if (!row?.last || row.score == null) return -999;
  let rank = 0;
  if (row.stage === 'wedge-drop') rank += 42;
  if (row.stage === 'exhaustion-extension') rank += 26;
  if (row.stage === 'reversal-extension') rank += 8;
  if (row.rs20 != null) rank += Math.min(22, Math.max(0, -row.rs20));
  if (row.volumeRatio != null && row.volumeRatio >= 1.5 && row.changePct != null && row.changePct < 0) rank += 6;
  rank += Math.max(0, 75 - row.score) / 2;
  if (row.changePct != null && row.changePct <= -5) rank += 6;
  return rank;
}

function pickFeatured(rows) {
  const up = take([...rows].sort((a, b) => upsideRank(b) - upsideRank(a)).filter((row) => upsideRank(row) > 40), MAX.featured);
  const upSet = new Set(up.map((row) => row.symbol));
  const down = take(
    [...rows].filter((row) => !upSet.has(row.symbol) && downsideRank(row) > 20)
      .sort((a, b) => downsideRank(b) - downsideRank(a)),
    MAX.featured
  );
  return { up, down };
}

function thesisUp(row, lv) {
  const bits = [`${row.stageLabel} · ${row.score}分`];
  if (row.rs20 != null) bits.push(`RS20 ${row.rs20 >= 0 ? '+' : ''}${row.rs20.toFixed(1)}`);
  if (row.volumeRatio != null) bits.push(`量能 ${row.volumeRatio.toFixed(1)}x`);
  if (lv?.atr != null && row.last > 0) bits.push(`ATR $${lv.atr}（${pctOf(lv.atr, row.last)}%）`);
  if (lv?.r1 != null) bits.push(`先看 R1 $${lv.r1}`);
  if (row.stop != null) bits.push(`失效 $${row.stop}`);
  return `${bits.join(' · ')}。金额是 ATR / 支撑阻力推出来的波动带，不是预测成交价。`;
}

function thesisDown(row, lv) {
  const bits = [`${row.stageLabel} · ${row.score}分`];
  if (row.rs20 != null) bits.push(`RS20 ${row.rs20 >= 0 ? '+' : ''}${row.rs20.toFixed(1)}`);
  if (row.stage === 'exhaustion-extension') bits.push('加速赶顶，先防回撤');
  if (row.stage === 'wedge-drop') bits.push('结构破坏，先看下行');
  if (lv?.atr != null && row.last > 0) bits.push(`ATR $${lv.atr}（${pctOf(lv.atr, row.last)}%）`);
  if (lv?.s1 != null) bits.push(`先看 S1 $${lv.s1}`);
  if (row.stop != null) bits.push(`失效 $${row.stop}`);
  return `${bits.join(' · ')}。金额是 ATR / 支撑阻力推出来的波动带，不是预测成交价。`;
}

async function enrichFeatured(row, side) {
  const hist = await loadHistoricals(row.symbol);
  const lv = hist?.ok ? computeLevels(closedBars(hist.bars), { lastOverride: row.last }) : { ok: false };
  const last = row.last;
  const atr = lv.ok ? lv.atr : row.atr;
  const vol20 = hist?.ok ? realizedVol(hist.bars, 20) : null;
  const toR1 = lv.ok && lv.r1 != null && last != null ? money(lv.r1 - last) : null;
  const toR2 = lv.ok && lv.r2 != null && last != null ? money(lv.r2 - last) : null;
  const toS1 = lv.ok && lv.s1 != null && last != null ? money(last - lv.s1) : null;
  const toS2 = lv.ok && lv.s2 != null && last != null ? money(last - lv.s2) : null;
  const toStop = row.stop != null && last != null ? money(last - row.stop) : null;
  return {
    ...row,
    side,
    atr: atr ?? null,
    atrPct: atr != null && last > 0 ? pctOf(atr, last) : row.atrPct,
    vol20,
    band: atr != null && last != null
      ? { low: money(last - atr), high: money(last + atr), dollars: atr, pct: pctOf(atr, last) }
      : null,
    stretch: atr != null && last != null
      ? { low: money(last - atr * 2), high: money(last + atr * 2), dollars: money(atr * 2), pct: pctOf(atr * 2, last) }
      : null,
    r1: lv.ok ? lv.r1 : null,
    r2: lv.ok ? lv.r2 : null,
    s1: lv.ok ? lv.s1 : null,
    s2: lv.ok ? lv.s2 : null,
    sl: lv.ok ? lv.sl : null,
    upside: {
      r1: lv.ok ? lv.r1 : null,
      r2: lv.ok ? lv.r2 : null,
      toR1,
      toR1Pct: pctOf(toR1, last),
      toR2,
      toR2Pct: pctOf(toR2, last)
    },
    downside: {
      s1: lv.ok ? lv.s1 : null,
      s2: lv.ok ? lv.s2 : null,
      sl: lv.ok ? lv.sl : null,
      stop: row.stop,
      toS1,
      toS1Pct: pctOf(toS1, last),
      toS2,
      toS2Pct: pctOf(toS2, last),
      toStop,
      toStopPct: pctOf(toStop, last)
    },
    thesis: side === 'up' ? thesisUp(row, lv.ok ? lv : { atr }) : thesisDown(row, lv.ok ? lv : { atr })
  };
}

function take(rows, n) {
  return rows.slice(0, n);
}

function px(n) {
  return n == null ? '—' : `$${Number(n).toFixed(2)}`;
}

function signedPct(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
}

function rateMd(score, stage) {
  const stats = lookupStageRate(score, stage);
  return stats?.n ? `${stats.rate}%（${stats.hits}/${stats.n}）` : '待结算';
}

function rowMd(row, score) {
  const rs = row.rs20 == null ? '—' : `${row.rs20 >= 0 ? '+' : ''}${row.rs20.toFixed(1)}`;
  const vol = row.volumeRatio == null ? '—' : `${row.volumeRatio.toFixed(1)}x`;
  const ch = row.changePct == null ? '—' : `${row.changePct >= 0 ? '+' : ''}${Number(row.changePct).toFixed(1)}%`;
  const last = row.last == null ? '—' : Number(row.last).toFixed(2);
  return `| ${row.symbol} | ${row.stageLabel} | ${rateMd(score, row.stage)} | ${row.score ?? '—'} | ${last} | ${ch} | ${rs} | ${vol} | ${(row.feeds || []).join('+') || '—'} | ${row.note} |`;
}

function featuredMd(row, score) {
  const band = row.band
    ? `${px(row.band.low)} ~ ${px(row.band.high)}（±${px(row.band.dollars)} / ${signedPct(row.band.pct)}）`
    : 'DATA UNAVAILABLE';
  const stretch = row.stretch
    ? `${px(row.stretch.low)} ~ ${px(row.stretch.high)}（±${px(row.stretch.dollars)}）`
    : '—';
  const up = row.upside?.r1 != null
    ? `R1 ${px(row.upside.r1)}（+${px(row.upside.toR1)} / ${signedPct(row.upside.toR1Pct)}）· R2 ${px(row.upside.r2)}（+${px(row.upside.toR2)}）`
    : 'DATA UNAVAILABLE';
  const down = row.downside?.s1 != null
    ? `S1 ${px(row.downside.s1)}（-${px(row.downside.toS1)} / ${signedPct(row.downside.toS1Pct)}）· 失效 ${px(row.downside.stop)}（-${px(row.downside.toStop)}）`
    : `失效 ${px(row.downside?.stop)}`;
  return `#### ${row.symbol} · ${row.stageLabel} · ${row.score ?? '—'}分 · ${formatWinRate(lookupStageRate(score, row.stage))}

- 现价 ${px(row.last)} · 当日 ${signedPct(row.changePct)} · ATR ${px(row.atr)}（${row.atrPct == null ? '—' : `${row.atrPct}%`}）· 20日年化波动 ${row.vol20 == null ? 'DATA UNAVAILABLE' : `${row.vol20}%`}
- 今日合理波动 ${band}
- 拉伸波动 ${stretch}
- 上行 ${up}
- 下行 ${down}
- ${row.thesis}
`;
}

export function renderWatchMarkdown(pack) {
  const score = pack.score;
  const sec = (title, rows, empty) => `### ${title}

| 代码 | 阶段 | 次日命中率 | 分 | 现价 | 当日 | RS20 | 量能 | 共振 | 说明 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${(rows || []).map((row) => rowMd(row, score)).join('\n') || `| — |  |  |  |  |  |  |  |  | ${empty} |`}
`;
  const stageLines = Object.values(score?.locked?.byStage || {})
    .filter((row) => row.id !== 'unknown')
    .sort((a, b) => (a.no || 99) - (b.no || 99))
    .map((row) => `- ${row.label}：${row.n ? `${row.rate}%（${row.hits}/${row.n}）` : '待结算'}`)
    .join('\n');
  return `---
title: 每日观察
date: ${pack.date}
type: daily-watchlist
strategy: cycle-of-price-action
liveTrading: false
---

# ${pack.date} 每日观察

> 足迹不是预测。先扫描、再确认、有计划再动。不是下单指令，不进推荐 / 模拟 / 实际操作。
> 策略：${CYCLE_NAME}。大盘 ${pack.regimeLabel || pack.regime}。只做 Wedge Pop / EMA Crossback / Base 'n Break，且 ≥80 分。缺日线写 DATA UNAVAILABLE。
> 每条后面的胜率是该 Cycle 阶段在「最可能涨/跌」里的次日方向胜率，不是带止损的交易胜率。

扫描 ${pack.scanned} 只 · 可开 ${pack.counts?.setups ?? 0} · 共振 ${pack.counts?.confluence ?? 0}。

## 阶段胜率

${stageLines || '- 还没有已结算样本。'}

## 最可能上涨

${(pack.featured?.up || []).map((row) => featuredMd(row, score)).join('\n') || '今日没有足够证据的上涨候选。'}

## 最可能下跌

${(pack.featured?.down || []).map((row) => featuredMd(row, score)).join('\n') || '今日没有足够证据的下跌候选。'}

${sec('共振确认', pack.boards.confluence, '今日没有周期+相对强度+量能同时成立的名字')}

${sec('周期入场 02 / 03 / 04', pack.boards.setups, '没有 ≥70 分的 Wedge Pop / EMA Crossback / Base n Break')}

${sec('量能扩张', pack.boards.volume, '没有明显放量')}

${sec('相对强度', pack.boards.rs, '没有跑赢 QQQ 的名字')}

${sec('避开 / 退出', pack.boards.avoid, '没有明显的 Exhaustion / Wedge Drop')}

## 纪律

- 这些是足迹，不是预测。下一次开盘要重新确认。
- 证据齐了再按计划做。0C 没有 A 级就空仓。
- 禁止追高、禁止因为跌多了摊低。
- 实盘默认不下单。
`;
}

export async function buildWatchlist({ date } = {}) {
  const day = date || lastSessionStamp();
  const universe = await loadUniverse();
  const symbols = [...new Set((universe.symbols || []).map((row) => row.symbol).filter(Boolean))];
  const quotes = await loadQuotes([...symbols, 'QQQ'], { concurrency: 8 });
  const lastBySymbol = Object.fromEntries(symbols.map((s) => [s, quotes[s]?.ok ? quotes[s].last : null]));
  const cycleBook = await loadCycleBook(symbols, {
    bySymbol: universe.bySymbol || {},
    lastBySymbol,
    concurrency: 5
  });
  const rows = symbols.map((symbol) => card(
    symbol,
    universe.bySymbol?.[symbol] || {},
    cycleBook.bySymbol?.[symbol],
    quotes[symbol]
  ));
  const confluence = take(
    rows
      .filter((row) => row.feeds.includes('cycle') && row.feeds.filter((f) => f !== 'avoid').length >= 2)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.feeds.length - a.feeds.length)),
    MAX.confluence
  );
  const setups = take(
    rows
      .filter((row) => row.allowNewLong || row.watch)
      .sort((a, b) => Number(b.allowNewLong) - Number(a.allowNewLong) || (b.score || 0) - (a.score || 0)),
    MAX.setups
  );
  const volume = take(
    rows
      .filter((row) => row.volumeRatio != null && row.volumeRatio >= 1.5)
      .sort((a, b) => b.volumeRatio - a.volumeRatio),
    MAX.volume
  );
  const rs = take(
    rows
      .filter((row) => row.rs20 != null && row.rs20 >= 3)
      .sort((a, b) => b.rs20 - a.rs20),
    MAX.rs
  );
  const avoid = take(
    rows
      .filter((row) => row.feeds.includes('avoid'))
      .sort((a, b) => (a.score || 99) - (b.score || 99)),
    MAX.avoid
  );
  const picked = pickFeatured(rows);
  const featured = {
    up: await Promise.all(picked.up.map((row) => enrichFeatured(row, 'up'))),
    down: await Promise.all(picked.down.map((row) => enrichFeatured(row, 'down')))
  };
  const generatedAt = new Date().toISOString();
  const strategy = { id: 'cycle-of-price-action', name: CYCLE_NAME, version: cycleBook.version };
  return {
    ok: true,
    liveTrading: false,
    type: 'daily-watchlist',
    date: day,
    generatedAt,
    strategy,
    // Never manufacture a historical full-universe observation from today's scan.
    universeSnapshot: day === lastSessionStamp() ? universeSnapshot({ date: day, generatedAt, strategy, rows }) : null,
    benchmarkSnapshot: quotes.QQQ?.ok ? { last: quotes.QQQ.last, quoteAt: quotes.QQQ.quoteAt } : null,
    regime: cycleBook.regime,
    regimeLabel: cycleBook.regimeLabel,
    scanned: symbols.length,
    listError: universe.error || null,
    counts: {
      confluence: confluence.length,
      setups: setups.length,
      confirmed: rows.filter((row) => row.allowNewLong).length,
      volume: volume.length,
      rs: rs.length,
      avoid: avoid.length,
      up: featured.up.length,
      down: featured.down.length
    },
    featured,
    boards: { confluence, setups, volume, rs, avoid },
    note: '足迹不是预测。不是下单。不进推荐/模拟/实际操作。'
  };
}

export async function writeWatchlist(pack) {
  await mkdir(OBSIDIAN_WATCH, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
  await saveUniverseSnapshot(pack.universeSnapshot);
  const stem = pack.date;
  const { score, ...disk } = pack;
  const json = `${JSON.stringify(disk, null, 2)}\n`;
  const snapshots = join(OBSIDIAN_WATCH, 'snapshots');
  await mkdir(snapshots, { recursive: true });
  try {
    // Freeze the existing first daily call before overwriting the display file.
    let frozen = json;
    try { frozen = await readFile(join(OBSIDIAN_WATCH, `${stem}.json`), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(snapshots, `${stem}.json`), frozen, { encoding: 'utf8', flag: 'wx' });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const md = `${renderWatchMarkdown(pack)}\n`;
  await writeFile(join(OBSIDIAN_WATCH, `${stem}.json`), json, 'utf8');
  await writeFile(join(OBSIDIAN_WATCH, `${stem}.md`), md, 'utf8');
  await writeFile(join(REPORTS_DIR, `${stem}-每日观察.json`), json, 'utf8');
  await writeFile(join(REPORTS_DIR, `${stem}-每日观察.md`), md, 'utf8');
  if (score) pack.score = score;
  return { dir: OBSIDIAN_WATCH, date: pack.date, file: stem, counts: pack.counts };
}

async function latestDatedJson(dir, { suffix = '.json', reportsPrefix } = {}) {
  try {
    const names = await readdir(dir);
    const dates = names
      .filter((name) => name.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}/.test(name))
      .map((name) => name.slice(0, 10))
      .filter((day, index, all) => all.indexOf(day) === index)
      .sort()
      .reverse();
    for (const day of dates) {
      const file = reportsPrefix
        ? join(dir, `${day}${reportsPrefix}`)
        : join(dir, `${day}${suffix === '.json' ? '.json' : suffix}`);
      const pack = await readJson(file);
      if (pack) return { day, pack };
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadWatchlist(date, { auto = true } = {}) {
  const calendar = date || todayStamp();
  const day = date || lastSessionStamp();
  const exact = (await readJson(join(OBSIDIAN_WATCH, `${day}.json`)))
    || (await readJson(join(REPORTS_DIR, `${day}-每日观察.json`)));
  if (exact) return attachWatchScore(exact);
  if (date) return null;
  if (auto) {
    try {
      const built = await buildAndWriteWatchlist({ date: day });
      built.autoBuilt = true;
      built.requestedDate = calendar;
      built.note = [
        built.note,
        calendar === day
          ? `已自动写入 ${day} 观察板。`
          : `日历 ${calendar} 不是交易日，已自动写入最近交易日 ${day}。`
      ].filter(Boolean).join(' ');
      return built;
    } catch (error) {
      const latest = (await latestDatedJson(OBSIDIAN_WATCH))
        || (await latestDatedJson(REPORTS_DIR, { suffix: '-每日观察.json', reportsPrefix: '-每日观察.json' }));
      if (!latest?.pack) return { ok: false, empty: true, error: error.message, note: `自动扫描 ${day} 失败：${error.message}` };
      return attachWatchScore({
        ...latest.pack,
        ok: latest.pack.ok !== false,
        stale: true,
        requestedDate: calendar,
        sessionDate: day,
        note: `自动扫描 ${day} 失败：${error.message}。先显示 ${latest.pack.date || latest.day}。`
      });
    }
  }
  const latest = (await latestDatedJson(OBSIDIAN_WATCH))
    || (await latestDatedJson(REPORTS_DIR, { suffix: '-每日观察.json', reportsPrefix: '-每日观察.json' }));
  if (!latest?.pack) return null;
  const pack = latest.pack;
  return attachWatchScore({
    ...pack,
    ok: pack.ok !== false,
    stale: true,
    requestedDate: calendar,
    sessionDate: day,
    note: `最近交易日 ${day} 还没有观察板，显示 ${pack.date || latest.day}。点「扫描并写入」生成新观察；打开页面不自动扫描。`
  });
}

export async function buildAndWriteWatchlist({ date } = {}) {
  const pack = await buildWatchlist({ date });
  if (pack.listError || !pack.scanned) throw new Error(pack.listError || '没有可扫描的美股清单，未覆盖已有观察板');
  // Save the observation before grading, so this run is immediately counted as pending.
  await writeWatchlist(pack);
  try {
    pack.score = await updateWatchScore({ asOf: pack.date });
  } catch (error) {
    pack.score = { ok: false, error: error.message };
  }
  return pack;
}
