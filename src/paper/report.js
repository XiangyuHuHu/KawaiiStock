import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_PAPER, REPORTS_DIR, chinaStamp, todayStamp } from '../paths.js';
import { buildDiagnostics, topReasons } from './diagnostics.js';
import { PAPER_DESKS } from '../risk/limits.js';

function deskRows(result) {
  return Object.entries(result?.sessions || {}).map(([id, session]) => {
    const diagnostics = session?.diagnostics || buildDiagnostics({ ...session, desk: session?.desk || id });
    return {
      desk: id,
      label: PAPER_DESKS[id]?.label || id,
      market: diagnostics.market,
      scanned: diagnostics.scanned,
      eligible: diagnostics.eligible,
      ordersPlaced: diagnostics.ordersPlaced,
      orders: diagnostics.orders,
      filterRejections: diagnostics.filterRejections,
      skipRejections: diagnostics.skipRejections,
      microstructure: diagnostics.microstructure?.reason || diagnostics.microstructure || null,
      note: session?.note || null,
      ok: session?.ok !== false
    };
  });
}

export function paperRunPayload(result, now = Date.now()) {
  return {
    type: 'paper-experiment-run',
    liveTrading: false,
    at: new Date(now).toISOString(),
    usDate: todayStamp(new Date(now)),
    cnDate: chinaStamp(new Date(now)),
    outsideSession: Boolean(result?.outsideSession),
    markets: result?.markets || null,
    note: result?.note || '',
    desks: deskRows(result)
  };
}

function reasonText(row) {
  const filters = topReasons(row.filterRejections);
  const skips = topReasons(row.skipRejections);
  return [filters && `过滤 ${filters}`, skips && `跳过 ${skips}`].filter(Boolean).join('。') || '—';
}

export function formatPaperRunMarkdown(payload) {
  const lines = [
    '---',
    'title: 纸上实验运行',
    `date: ${payload.usDate}`,
    'type: paper-experiment',
    'liveTrading: false',
    '---',
    '',
    `# ${payload.usDate} 纸上实验运行`,
    '',
    `> 北京日期 ${payload.cnDate}。只改纸上账，不发券商单。`,
    `> ${payload.note || ''}`,
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

export async function writePaperRunReport(result, now = Date.now()) {
  const payload = paperRunPayload(result, now);
  const markdown = formatPaperRunMarkdown(payload);
  const stem = `${payload.usDate}-纸上实验`;
  await mkdir(REPORTS_DIR, { recursive: true });
  await appendFile(join(REPORTS_DIR, `${stem}.jsonl`), `${JSON.stringify(payload)}\n`, 'utf8');
  await writeFile(join(REPORTS_DIR, `${stem}.md`), markdown, 'utf8');
  try {
    await mkdir(OBSIDIAN_PAPER, { recursive: true });
    await writeFile(join(OBSIDIAN_PAPER, `${stem}.md`), markdown, 'utf8');
  } catch {
    /* 纸上目录缺失不影响账本。 */
  }
  return { file: stem, payload };
}
