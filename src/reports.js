import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { OBSIDIAN_DAILY, REPORTS_DIR, recsDir, recsLegacyDir, lastSessionStamp } from './paths.js';
import { extractSection, parseFrontmatter, renderMarkdown } from './markdown.js';

async function listMarkdown(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadDailyReports() {
  const observationDate = lastSessionStamp();
  const vaultFiles = await listMarkdown(OBSIDIAN_DAILY);
  const localFiles = await listMarkdown(REPORTS_DIR);
  const byDate = new Map();

  async function ingest(dir, file, source) {
    if (file.startsWith('00 ') || file.includes('推荐') || file.includes('实际操作') || file.includes('模拟操作')) return;
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) return;
    const raw = await readFile(join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const date = meta.date || basename(file, '.md');
    const json = await readJsonIfExists(join(dir, `${date}.json`));
    const current = byDate.get(date);
    if (current && current.source === 'vault' && source === 'local') return;
    byDate.set(date, {
      date,
      observationDate,
      stale: date !== observationDate || json?.stale === true,
      file,
      source,
      meta,
      body,
      html: renderMarkdown(body),
      json,
      headline: extractSection(body, '今日结论').split('\n')[0] || meta.headline || '',
      stance: meta.stance || json?.verdict?.stance || 'WAIT'
    });
  }

  for (const file of localFiles) await ingest(REPORTS_DIR, file, 'local');
  for (const file of vaultFiles) await ingest(OBSIDIAN_DAILY, file, 'vault');
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function loadRecFiles(advisor = 'grok', options = {}) {
  const who = advisor === 'chatgpt' ? 'chatgpt' : 'grok';
  const dirs = options.dirs || [recsDir(who), recsLegacyDir(who)];
  const byDate = new Map();
  for (const dir of dirs) {
    let names=[];
    try { names=await readdir(dir); } catch { continue; }
    const dates=[...new Set(names.filter(n=>/^\d{4}-\d{2}-\d{2}\.(md|json)$/.test(n)).map(n=>n.slice(0,10)))];
    for (const date of dates) {
      if (byDate.has(date)) continue;
      const files=[], errors=[];
      let meta={}, html='', json=null;
      if(names.includes(`${date}.md`)) {
        files.push(join(dir,`${date}.md`));
        try {
          const parsed=parseFrontmatter((await readFile(join(dir,`${date}.md`),'utf8')).replace(/^\uFEFF/,''));
          meta=parsed.meta;html=renderMarkdown(parsed.body);
        } catch {errors.push('Markdown 读取失败');}
      }
      if(names.includes(`${date}.json`)) {
        files.push(join(dir,`${date}.json`));
        try {json=JSON.parse((await readFile(join(dir,`${date}.json`),'utf8')).replace(/^\uFEFF/,''));}
        catch {errors.push('推荐 JSON 无法解析');}
      }
      if((meta.date && meta.date!==date)||(json?.date && json.date!==date))errors.push('推荐内容日期与文件名不一致');
      if(json?.advisor && json.advisor!==who)errors.push('推荐顾问与所选台不一致');
      byDate.set(date,{date,meta,html,json:errors.length?null:json,files,error:errors.join('；')||null});
    }
  }
  return [...byDate.values()].sort((a,b)=>b.date.localeCompare(a.date));
}

export async function ensureVaultDirs() {
  await mkdir(OBSIDIAN_DAILY, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
}
