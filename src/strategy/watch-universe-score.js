import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_WATCH, isUsSessionDay } from '../paths.js';
import { sessionClosed } from '../market-time.js';
import { STAGE_LIST } from './cycle.js';

const directory = () => join(OBSIDIAN_WATCH, 'universe-snapshots');
const stages = STAGE_LIST.filter((stage) => stage.id !== 'unknown');
const rounded = (n) => Math.round(n * 100) / 100;

export function universeSnapshot({ date, generatedAt, strategy, rows }) {
  const seen = new Set();
  return {
    schemaVersion: 1, date, generatedAt, version: strategy?.version || 'unknown',
    rows: rows.filter((row) => {
      const key = String(row.symbol || '').trim().toUpperCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((row) => ({
      symbol: String(row.symbol).trim().toUpperCase(), stage: row.stage,
      last: row.last, priceDate: row.priceDate || null, quoteAt: row.quoteAt,
      signalDate: row.signalDate, version: row.version || strategy?.version || 'unknown'
    }))
  };
}

export async function saveUniverseSnapshot(snapshot) {
  if (!snapshot || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || !Array.isArray(snapshot.rows)) return;
  await mkdir(directory(), { recursive: true });
  try {
    // Re-scanning a date must not rewrite its original observation or outcomes.
    await writeFile(join(directory(), `${snapshot.date}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function loadUniverseSnapshots() {
  let names;
  try { names = await readdir(directory()); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const snapshots = [];
  for (const name of names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
    const pack = JSON.parse(await readFile(join(directory(), name), 'utf8'));
    if (pack.schemaVersion === 1 && pack.date === name.slice(0, 10) && Array.isArray(pack.rows)) snapshots.push(pack);
  }
  return snapshots;
}

function nextSession(date) {
  const cursor = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 10; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const stamp = cursor.toISOString().slice(0, 10);
    if (isUsSessionDay(stamp)) return stamp;
  }
  return null;
}

function totals(rows) {
  const locked = rows.filter((row) => row.status === 'locked');
  const n = locked.length;
  const up = locked.filter((row) => row.retPct > 0).length;
  const down = locked.filter((row) => row.retPct < 0).length;
  return {
    observed: rows.length, n, up, down, flat: n - up - down,
    upRate: n ? rounded(up / n * 100) : null,
    downRate: n ? rounded(down / n * 100) : null,
    avgRet: n ? rounded(locked.reduce((sum, row) => sum + row.retPct, 0) / n) : null,
    pending: rows.filter((row) => row.status === 'pending').length,
    awaitingClose: rows.filter((row) => row.reason === 'awaiting-close').length,
    missingBar: rows.filter((row) => row.reason === 'missing-next-session-bar').length,
    excluded: rows.filter((row) => row.status === 'excluded').length
  };
}

export function summarizeUniverse(snapshots, hists, { now = new Date(), legacyDates = [] } = {}) {
  const samples = [];
  const seen = new Set();
  for (const snapshot of snapshots) {
    const settleDate = nextSession(snapshot.date);
    for (const row of snapshot.rows) {
      const key = `${snapshot.date}:${String(row.symbol).toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sample = { ...row, callDate: snapshot.date, settleDate, status: 'pending', retPct: null };
      const from = Number(row.last);
      if (!stages.some((stage) => stage.id === row.stage)) {
        sample.status = 'excluded'; sample.reason = 'unknown-stage';
      } else if (!(from > 0) || !Number.isFinite(from) || row.priceDate !== snapshot.date) {
        sample.status = 'excluded'; sample.reason = 'missing-or-stale-observation-price';
      } else if (!sessionClosed(settleDate, now)) {
        sample.reason = 'awaiting-close';
      } else {
        // Require the exact next trading session; a later bar cannot fill a data gap.
        const bar = hists[row.symbol]?.ok && hists[row.symbol].bars?.find((bar) => bar.date === settleDate);
        if (bar?.close > 0 && Number.isFinite(Number(bar.close))) {
          sample.status = 'locked'; sample.to = Number(bar.close);
          sample.retPct = (sample.to / from - 1) * 100;
        } else sample.reason = 'missing-next-session-bar';
      }
      samples.push(sample);
    }
  }
  const dates = [...new Set(snapshots.map((row) => row.date))].sort();
  return {
    scope: 'full-universe', liveTrading: false, updatedAt: now.toISOString(),
    firstDate: dates[0] || null, lastDate: dates.at(-1) || null, dates,
    uncollectedDates: [...new Set(legacyDates)].filter((date) => !dates.includes(date)).sort(),
    rule: '完整扫描中每交易日、每只股票记一次；观察价对比下一交易日收盘。展示上涨/下跌频率，不预设交易方向，不与精选候选命中率合并。',
    all: totals(samples),
    byStage: Object.fromEntries(stages.map((stage) => [stage.id, { label: stage.label, ...totals(samples.filter((row) => row.stage === stage.id)) }])),
    samples
  };
}
