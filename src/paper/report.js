import { access } from 'node:fs/promises';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_PAPER, REPORTS_DIR, chinaStamp, todayStamp } from '../paths.js';
import { buildDiagnostics, topReasons } from './diagnostics.js';
import { paperMarketOf } from './sessions.js';
import { PAPER_DESKS } from '../risk/limits.js';

function deskRows(result, now) {
  const instant = new Date(now);
  return Object.entries(result?.sessions || {}).map(([id, session]) => {
    const diagnostics = session?.diagnostics || buildDiagnostics({ ...session, desk: session?.desk || id });
    const market = diagnostics.market || paperMarketOf(id);
    return {
      desk: id,
      label: PAPER_DESKS[id]?.label || id,
      market,
      marketDate: market === 'cn' ? chinaStamp(instant) : todayStamp(instant),
      scanned: diagnostics.scanned,
      eligible: diagnostics.eligible,
      ordersPlaced: diagnostics.ordersPlaced,
      orders: diagnostics.orders,
      filterRejections: diagnostics.filterRejections,
      skipRejections: diagnostics.skipRejections,
      microstructure: diagnostics.microstructure?.reason || diagnostics.microstructure || null,
      limitUpPool: diagnostics.limitUpPool || null,
      note: session?.note || null,
      ok: session?.ok !== false
    };
  });
}

export function paperRunPayload(result, now = Date.now()) {
  const instant = new Date(now);
  const desks = deskRows(result, instant);
  const cnDate = chinaStamp(instant);
  return {
    type: 'paper-experiment-run',
    liveTrading: false,
    at: instant.toISOString(),
    usDate: todayStamp(instant),
    cnDate,
    outsideSession: Boolean(result?.outsideSession),
    markets: result?.markets || null,
    note: result?.note || '',
    companion: desks.some((row) => row.market === 'cn') ? `${cnDate}-纸上实验-A股` : null,
    desks
  };
}

function reasonText(row) {
  const filters = topReasons(row.filterRejections);
  const skips = topReasons(row.skipRejections);
  const pool = row.limitUpPool?.error ? `涨停池 ${row.limitUpPool.error}` : '';
  return [filters && `过滤 ${filters}`, skips && `跳过 ${skips}`, pool].filter(Boolean).join('。') || '—';
}

export function formatPaperRunMarkdown(payload) {
  const date = payload.reportDate || payload.usDate;
  const lines = [
    '---',
    'title: 纸上实验运行',
    `date: ${date}`,
    'type: paper-experiment',
    'liveTrading: false',
    '---',
    '',
    `# ${date} 纸上实验运行`,
    '',
    ...[
      `> 美东日期 ${payload.usDate}，北京日期 ${payload.cnDate}。只改纸上账，不发券商单。`,
      payload.scope === 'cn' ? '> 这一份只收 A 股账本，按北京日期归档。' : '',
      payload.companion ? `> A 股账本另见 ${payload.companion}。` : '',
      payload.note ? `> ${payload.note}` : ''
    ].filter(Boolean),
    '',
    `| 账本 | 市场 | 扫描 | 买点 | 成交 | 原因 |`,
    `| --- | --- | ---: | ---: | ---: | --- |`
  ];
  for (const row of payload.desks) {
    const orders = (row.orders || []).map((order) => `${order.side} ${order.symbol}×${order.qty}@${order.price}`).join('，');
    lines.push(`| ${row.desk} | ${row.market === 'cn' ? 'A股' : '美股'} | ${row.scanned ?? '—'} | ${row.eligible ?? '—'} | ${row.ordersPlaced ?? 0}${orders ? `（${orders}）` : ''} | ${reasonText(row)} |`);
  }
  if (!payload.desks.length) lines.push('| — |  |  |  |  | 本轮没有账本 |');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeReportFiles(stem, payload, markdown, { overwriteMd = true } = {}) {
  await mkdir(REPORTS_DIR, { recursive: true });
  await appendFile(join(REPORTS_DIR, `${stem}.jsonl`), `${JSON.stringify(payload)}\n`, 'utf8');
  const mdPath = join(REPORTS_DIR, `${stem}.md`);
  if (overwriteMd || !(await fileExists(mdPath))) await writeFile(mdPath, markdown, 'utf8');
  try {
    await mkdir(OBSIDIAN_PAPER, { recursive: true });
    const vaultMd = join(OBSIDIAN_PAPER, `${stem}.md`);
    if (overwriteMd || !(await fileExists(vaultMd))) await writeFile(vaultMd, markdown, 'utf8');
  } catch {
    /* 纸上目录缺失不影响账本。 */
  }
}

export async function writePaperRunReport(result, now = Date.now()) {
  const payload = paperRunPayload(result, now);
  const cnDesks = payload.desks.filter((row) => row.market === 'cn');
  const companion = `${payload.cnDate}-纸上实验-A股`;
  const full = {
    ...payload,
    scope: 'all',
    reportDate: payload.usDate,
    companion: cnDesks.length ? companion : null
  };
  const stem = `${payload.usDate}-纸上实验`;
  await writeReportFiles(stem, full, formatPaperRunMarkdown(full));
  if (cnDesks.length) {
    const cnPayload = {
      ...payload,
      scope: 'cn',
      reportDate: payload.cnDate,
      companion: null,
      desks: cnDesks,
      companionOf: stem
    };
    const informative = cnDesks.some((row) => row.scanned != null);
    await writeReportFiles(companion, cnPayload, formatPaperRunMarkdown(cnPayload), { overwriteMd: informative });
  }
  return { file: stem, cnFile: cnDesks.length ? companion : null, payload: full };
}
