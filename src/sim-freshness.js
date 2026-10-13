import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTUALS_DIR, actualsDir, asOfStamp, recsDir, recsLegacyDir } from './paths.js';
import { deskById, loadHoldings } from './holdings.js';
import { parseFrontmatter } from './markdown.js';

// Source dates must come from dated artifacts or their data, never request time/mtime.
export function sourceDate(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isFinite(new Date(value).getTime())) return null;
  const day = asOfStamp(value);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

async function datedFiles(dirs, kind) {
  const files = [];
  for (const dir of [...new Set(dirs)]) {
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.(json|md)$/);
      if (!match || !sourceDate(match[1])) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, 'utf8');
        const isJson = match[2] === 'json';
        const json = isJson ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null;
        const meta = isJson ? json : parseFrontmatter(raw).meta;
        const usable = isJson
          ? kind === 'recommendation'
            ? Array.isArray(json?.accounts) || Array.isArray(json?.orders)
            : Array.isArray(json?.entries)
          : Boolean(raw.trim());
        if (!usable) continue;
        // A mismatched declared date is not a current file just because it was renamed.
        const date = meta.date == null ? match[1] : sourceDate(meta.date);
        files.push({ date, path, format: match[2], fileDate: match[1], dateMismatch: date !== match[1] });
      } catch { /* Unreadable/malformed files are not evidence of an update. */ }
    }
  }
  return files.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function latestDate(rows) {
  return rows.map((row) => sourceDate(row.date)).filter(Boolean).sort().at(-1) || null;
}

function datedSource(label, date, observationDate, details = {}) {
  const reasons = [];
  if (!date) reasons.push(`${label}缺失或日期未知，无法确认已更新至 ${observationDate}`);
  else if (date < observationDate) reasons.push(`${label}最新为 ${date}，落后于观察日 ${observationDate}`);
  else if (date > observationDate) reasons.push(`${label}日期 ${date} 晚于观察日 ${observationDate}，需核对`);
  return { label, date, ...details, reasons };
}

export function buildSimFreshness({ observationDate, recommendations = [], actuals = [], holdings = [], history = [], accountId = 'all' }) {
  const rec = recommendations[0];
  const recommendation = datedSource('推荐文件', sourceDate(rec?.date), observationDate, { path: rec?.path || null });
  if (rec?.dateMismatch) recommendation.reasons.push('推荐文件名与内容日期不一致');
  const executable = recommendations.find((row) => row.format === 'json' && !row.dateMismatch);
  recommendation.executableDate = sourceDate(executable?.date);
  if (rec && recommendation.executableDate !== observationDate) {
    recommendation.reasons.push(`观察日 ${observationDate} 缺少有效推荐 JSON；最新可解析 JSON：${recommendation.executableDate || '缺失'}。缺文件不代表 HOLD 建议`);
  }

  const relevantHoldings = holdings.filter((row) => accountId === 'all' || row.id === accountId);
  const ids = relevantHoldings.map((row) => row.id);
  const relevantHistory = history.filter((day) => accountId === 'all' || day.plans?.[accountId]);
  const completeHistory = relevantHistory.filter((day) => ids.length && ids.every((id) => day.plans?.[id]?.basis === 'daily-rec'));
  const settlement = datedSource('模拟结算', latestDate(completeHistory), observationDate, { latestAttemptDate: latestDate(relevantHistory) });
  const latestAttempt = [...relevantHistory].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  if (latestAttempt && !ids.every((id) => latestAttempt.plans?.[id]?.basis === 'daily-rec')) {
    settlement.reasons.push(`${latestAttempt.date || '日期未知'} 的模拟记录缺少有效推荐或账户计划，仅保留持仓/估值，不计为有效结算更新`);
  }

  const actual = datedSource('实际操作', sourceDate(actuals[0]?.date), observationDate, { path: actuals[0]?.path || null });
  if (actuals[0]?.dateMismatch) actual.reasons.push('实际操作文件名与内容日期不一致');
  const accounts = relevantHoldings.map((row) => {
    const item = datedSource(`${row.label}持仓快照`, sourceDate(row.dataAsOf || row.asOf), observationDate, { id: row.id });
    if (row.missing || row.scanStatus === 'unavailable') item.reasons.push(`${row.label}持仓来源缺失或扫描不可用`);
    return item;
  });
  const snapshot = datedSource('持仓快照', latestDate(accounts), observationDate, { accounts });
  snapshot.reasons = accounts.length ? accounts.flatMap((row) => row.reasons) : snapshot.reasons;
  const sources = { recommendation, settlement, actual, holdings: snapshot };
  const reasons = Object.values(sources).flatMap((row) => row.reasons);
  return { observationDate, accountId, stale: reasons.length > 0, liveTrading: false, sources, reasons };
}

export async function loadChatgptFreshness(config, ledger, observationDate) {
  const [recommendations, actuals, holdings] = await Promise.all([
    datedFiles([recsDir('chatgpt'), recsLegacyDir('chatgpt')], 'recommendation'),
    datedFiles([actualsDir('chatgpt'), join(ACTUALS_DIR, 'chatgpt')], 'actual'),
    Promise.all(deskById(config, 'chatgpt').accounts.map(async (account) => ({
      ...await loadHoldings(account), id: account.id, label: account.label
    })))
  ]);
  return Object.fromEntries(['all', ...holdings.map((row) => row.id)].map((accountId) => [accountId,
    buildSimFreshness({ observationDate, recommendations, actuals, holdings, history: ledger.history || [], accountId })
  ]));
}
