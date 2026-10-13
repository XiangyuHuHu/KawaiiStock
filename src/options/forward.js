import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_OPTIONS } from '../paths.js';
import { loadOptionChain, mapPool } from './market.js';
import { legsOf, quoteIssues, MODEL_VERSION } from './contracts.js';
import { reassessOptions } from './safety.js';

export const FORWARD_RULE = 'same-contract-target-plus-5m-v1';
export const WINDOW_MS = 300000;
const validId = id => /^[a-f0-9-]{36}$/.test(id || '');

export function makeForwardRecords(pack, now = Date.now()) {
  return reassessOptions(pack, now).ideas.map(row => ({
    id: `${pack.scanId}:${row.symbol}`, scanId: pack.scanId, symbol: row.symbol, modelVersion: MODEL_VERSION,
    rule: FORWARD_RULE, action: row.originalAction || row.action, horizon: row.horizon,
    targetAt: row.targetAt, entryAt: pack.generatedAt, recordedAt: new Date(now).toISOString(),
    legs: legsOf(row), costs: row.costs, status: row.eligible ? 'pending' : 'excluded',
    attempts: 0, reason: row.eligible ? '等待固定视界的同合约双边报价' : row.blockers.join('；') || '非候选',
    kind: '假设按公开报价进出，非实际成交'
  }));
}

export function settleForward(record, chain, now = Date.now()) {
  if (record.status !== 'pending') return record;
  if (!Number.isFinite(record.targetAt) || !record.legs?.length || !Number.isFinite(record.costs?.debit) || !Number.isFinite(record.costs?.roundTripFees)) {
    return { ...record, status: 'excluded', reason: '原始合约、固定退出时刻或含费基线不完整，不能结算' };
  }
  if (now < record.targetAt) return record;
  if (now > record.targetAt + WINDOW_MS) return { ...record, status: 'missing', reason: '固定视界后 5 分钟内未取得有效报价（可能因停机、断网或源数据缺失）；不使用更晚价格补算' };
  const all = [...(chain?.calls || []), ...(chain?.puts || [])];
  const quotes = record.legs.map(leg => all.find(q => q.contractSymbol === leg.contractSymbol && q.expiration === leg.expiration && q.type === leg.type && q.strike === leg.strike));
  if (quotes.some(q => !q || quoteIssues(q).length || q.standard !== true || q.multiplier !== 100 || !(q.quoteAt >= record.targetAt && q.quoteAt <= now + 5000) || now - q.quoteAt > 180000 || [q.bidAt, q.askAt].some(t => t > now + 5000))) return { ...record, reason: '等待：相同合约缺可验证的及时双边报价' };
  const exitValue = quotes.reduce((sum, q, i) => sum + (record.legs[i].side === 'buy' ? q.bid : -q.ask) * 100, 0);
  const netPnl = exitValue - record.costs.debit - record.costs.roundTripFees;
  return { ...record, status: 'locked', exitAt: new Date(now).toISOString(), exitQuotes: quotes,
    exitValue: Math.round(exitValue * 100) / 100, grossPnl: Math.round((exitValue - record.costs.debit) * 100) / 100,
    netPnl: Math.round(netPnl * 100) / 100, reason: '按同合约可见买卖报价计算，扣双程费用；非成交收益' };
}

export function createForwardStore({ dir = join(OBSIDIAN_OPTIONS, 'forward-quotes'), now = Date.now, chainLoader = loadOptionChain } = {}) {
  let queue = Promise.resolve();
  const serialized = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  async function files() { try { return (await readdir(dir)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function read(path) { return JSON.parse(await readFile(path, 'utf8')); }
  async function write(path, value) { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), 'utf8'); await rename(`${path}.tmp`, path); }
  async function loadPacks() {
    const packs = [], errors = [];
    for (const name of await files()) {
      try { const pack = await read(join(dir, name)); if (!Array.isArray(pack.records)) throw new Error('records missing'); packs.push({ name, pack }); }
      catch { errors.push(`复盘文件无法读取：${name}（保留原文件）`); }
    }
    return { packs, errors };
  }
  async function load({ scanId, all = false } = {}) {
    const { packs, errors } = await loadPacks();
    const records = packs.flatMap(({ pack }) => pack.records).filter(r => !scanId || r.scanId === scanId).sort((a, b) => String(a.entryAt || '').localeCompare(String(b.entryAt || '')));
    const groups = ['60m', '3d'].map(horizon => {
      const valid = records.filter(r => r.status === 'locked' && r.horizon === horizon && r.modelVersion === MODEL_VERSION && (!r.rule || r.rule === FORWARD_RULE) && Number.isFinite(r.netPnl));
      return { horizon, n: valid.length, wins: valid.filter(r => r.netPnl > 0).length, netPnl: valid.length ? Math.round(valid.reduce((s, r) => s + r.netPnl, 0) * 100) / 100 : null };
    });
    const pending = records.filter(r => r.status === 'pending');
    const targets = pending.map(r => r.targetAt).filter(Number.isFinite);
    return { ok: true, groups, pending: pending.length, nextTargetAt: targets.length ? Math.min(...targets) : null,
      excluded: records.filter(r => r.status === 'excluded').length, missing: records.filter(r => r.status === 'missing').length,
      total: records.length, records: (all || scanId ? records : records.slice(-80)).reverse(), errors,
      note: '仅保存后向前采集；60 分钟与 3 个交易日分组，按同一固定退出窗口。后台只读取待观察合约，停机或错过窗口记缺失；旧扫描缺历史期权报价不能回填。'
    };
  }
  async function record(pack) {
    if (!validId(pack.scanId)) return;
    return serialized(async () => {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${pack.scanId}.json`);
      try { await readFile(path); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await write(path, { scanId: pack.scanId, records: makeForwardRecords(pack, now()) });
    });
  }
  async function refresh() {
    return serialized(async () => {
      const { packs, errors } = await loadPacks();
      const requests = new Map(), start = now();
      for (const { pack } of packs) for (const r of pack.records) {
        if (r.status !== 'pending' || !r.legs?.length || !(start >= r.targetAt && start <= r.targetAt + WINDOW_MS)) continue;
        const expiration = r.legs[0].expiration, key = `${r.symbol}:${expiration}`;
        if (!requests.has(key)) requests.set(key, { symbol: r.symbol, expiration, deadline: r.targetAt + WINDOW_MS });
      }
      const replies = new Map();
      await mapPool([...requests].sort((a, b) => a[1].deadline - b[1].deadline), async ([key, job]) => {
        if (now() > job.deadline) return;
        try { replies.set(key, { chain: await chainLoader(job.symbol, Date.parse(`${job.expiration}T00:00:00Z`) / 1000, { refresh: true }) }); }
        catch { replies.set(key, { error: '行情请求失败，将在窗口内重试' }); }
      }, { concurrency: 3 });
      let changed = 0;
      for (const { name, pack } of packs) {
        let dirty = false;
        pack.records = pack.records.map(row => {
          if (row.status !== 'pending' || now() < row.targetAt) return row;
          const response = replies.get(`${row.symbol}:${row.legs?.[0]?.expiration}`);
          const attempted = response ? { ...row, attempts: (row.attempts || 0) + 1, lastAttemptAt: new Date(now()).toISOString() } : row;
          let next = settleForward(attempted, response?.chain, now());
          if (response?.error && next.status === 'pending') next = { ...next, reason: response.error };
          if (JSON.stringify(next) !== JSON.stringify(row)) { dirty = true; changed++; }
          return next;
        });
        if (dirty) await write(join(dir, name), pack);
      }
      return { ...(await load()), collection: { startedAt: new Date(start).toISOString(), completedAt: new Date(now()).toISOString(), requests: replies.size, changed, errors } };
    });
  }
  return { load, record, refresh };
}
const store = createForwardStore();
export const loadForward = store.load;
export const recordForward = store.record;
export const refreshForward = store.refresh;
