import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OBSIDIAN_OPTIONS } from '../paths.js';
import { reassessOptions } from './safety.js';

const archiveDir = join(OBSIDIAN_OPTIONS, 'snapshots');
const validId = id => /^[a-f0-9-]{36}$/.test(id || '');
const fingerprint = pack => createHash('sha256').update(JSON.stringify(pack)).digest('hex');
async function read(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function names(path) { try { return await readdir(path); } catch { return []; } }

export async function archiveOptions(pack) {
  await mkdir(archiveDir, { recursive: true });
  const id = validId(pack.scanId) ? pack.scanId : `legacy-${fingerprint(pack)}`;
  const path = join(archiveDir, `${id}.json`);
  try { await writeFile(path, JSON.stringify(pack, null, 2), { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await read(path);
    if (!previous || fingerprint(previous) !== fingerprint(pack)) throw new Error('已有快照内容不同，拒绝覆盖历史记录');
  }
  return id;
}

async function entries(strategyId) {
  const dated = (await names(OBSIDIAN_OPTIONS)).filter(n => /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.json$/.test(n));
  const archived = (await names(archiveDir)).filter(n => /^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{64})\.json$/.test(n));
  const files = [...archived.map(n => ({ key: `snapshot:${n.slice(0, -5)}`, path: join(archiveDir, n) })), ...dated.map(n => ({ key: `day:${n.slice(0, -5)}`, path: join(OBSIDIAN_OPTIONS, n) }))];
  const loaded = await Promise.all(files.map(async file => ({ ...file, pack: await read(file.path) })));
  const seen = new Set();
  return loaded.filter(entry => {
    const p = entry.pack;
    if (!p?.date || (p.strategy?.id || 'cov') !== strategyId) return false;
    const id = p.scanId || fingerprint(p);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((a, b) => String(b.pack.date).localeCompare(String(a.pack.date)) || String(b.pack.generatedAt || '').localeCompare(String(a.pack.generatedAt || '')));
}

export async function listOptionsHistory(strategyId = 'cov') {
  return (await entries(strategyId)).map(({ key, pack }) => ({ key, date: pack.date, generatedAt: pack.generatedAt || null,
    scanId: pack.scanId || null, modelVersion: pack.modelVersion || null, scanned: pack.ideas?.length || 0,
    originalBuyCount: pack.buys?.length || 0 }));
}

export async function loadOptionsHistory(key, strategyId = 'cov') {
  const entry = (await entries(strategyId)).find(e => e.key === key);
  if (!entry) return null;
  const original = entry.pack;
  const pack = reassessOptions(original);
  return { ...pack, historicalView: true, historyKey: key, cached: true,
    historicalBuys: structuredClone(original.buys || []),
    historicalCounts: original.counts || { buy: original.buys?.length || 0, scanned: original.ideas?.length || 0 },
    buys: [], ideas: pack.ideas.map(row => ({ ...row, eligible: false, action: 'NO_TRADE', contractRole: 'reference' })),
    counts: { ...pack.counts, buy: 0 }, note: '历史回看：保留当时判断和报价，不作为当前推荐。' };
}
