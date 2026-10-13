import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.js';
import {
  QUOTE_NOTE,
  QUOTE_STATUS,
  bookPremiumYield,
  emptyWheelLedger,
  markWheel,
  openCashSecuredPut,
  openCoveredCall,
  rollWheel,
  settleWheel
} from './wheel.js';

export function wheelPath() {
  return join(DATA_DIR, 'paper', 'wheel.json');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadWheelLedger() {
  const raw = await readJson(wheelPath());
  if (!raw || raw.type !== 'paper-wheel') return emptyWheelLedger();
  return {
    ...emptyWheelLedger(raw.updatedAt),
    ...raw,
    id: 'paper-wheel',
    type: 'paper-wheel',
    liveTrading: false,
    positions: raw.positions || {},
    closedCycles: raw.closedCycles || []
  };
}

export async function saveWheelLedger(ledger) {
  await mkdir(join(DATA_DIR, 'paper'), { recursive: true });
  const next = markWheel({ ...ledger, liveTrading: false, type: 'paper-wheel', id: 'paper-wheel' });
  const temp = `${wheelPath()}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, wheelPath());
  return next;
}

export async function resetWheelLedger() {
  return saveWheelLedger(emptyWheelLedger());
}

export function presentWheel(ledger, { candidates = [], asOf = new Date().toISOString() } = {}) {
  const marked = markWheel(ledger, {}, asOf);
  return {
    ok: true,
    liveTrading: false,
    quoteStatus: QUOTE_STATUS,
    quoteNote: QUOTE_NOTE,
    annualizedYield: bookPremiumYield(marked, asOf),
    ledger: marked,
    candidates,
    note: '纸上轮证，不下真实单。报价是延迟/参考数据。卖出现金担保认沽锁定行权价×100；指派后成本 = 行权价 − 权利金。股价下跌时亏损可以大于权利金，轮证不是无风险策略。年化只按已收权利金相对占用资金估算，没有把下跌亏损算成收益。'
  };
}

export async function readWheel({ candidates = [], asOf } = {}) {
  return presentWheel(await loadWheelLedger(), { candidates, asOf });
}

export async function postWheel(body = {}) {
  const action = String(body.action || '');
  if (action === 'reset') {
    const ledger = await resetWheelLedger();
    return presentWheel(ledger);
  }
  const ledger = await loadWheelLedger();
  let result;
  if (action === 'open') {
    result = body.side === 'call' ? openCoveredCall(ledger, body) : openCashSecuredPut(ledger, body);
  } else if (action === 'settle') {
    result = settleWheel(ledger, body);
  } else if (action === 'roll') {
    result = rollWheel(ledger, body);
  } else if (action === 'mark') {
    result = { ok: true, liveTrading: false, ledger: markWheel(ledger, body.spots || {}, body.asOf) };
  } else {
    return { ok: false, liveTrading: false, error: '未知动作。可用 open、settle、roll、mark、reset。' };
  }
  if (!result.ok) return { ...result, liveTrading: false };
  const saved = await saveWheelLedger(result.ledger);
  return { ...presentWheel(saved, { asOf: body.asOf }), symbol: result.symbol || null, warning: result.warning || null };
}
