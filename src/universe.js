import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoResearchUniverse } from './demo-pool.js';
import { OBSIDIAN_LISTS } from './paths.js';

const TICKER_RE = /\*\*([A-Z][A-Z0-9.-]{0,9})\*\*/g;

function extractTickers(markdown) {
  const found = [];
  const seen = new Set();
  for (const match of String(markdown).matchAll(TICKER_RE)) {
    const symbol = match[1];
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    found.push(symbol);
  }
  return found;
}

function classifyFile(name) {
  if (name.includes('严选')) return 'primary';
  if (name.includes('乱选')) return 'tactical';
  if (name.includes('十倍')) return 'highBeta';
  return 'other';
}

export async function loadUniverse() {
  let files = [];
  try {
    files = (await readdir(OBSIDIAN_LISTS)).filter((name) => name.endsWith('.md') && !name.startsWith('00 '));
  } catch {
    return demoResearchUniverse();
  }

  const lists = [];
  const bySymbol = {};
  for (const file of files) {
    const markdown = await readFile(join(OBSIDIAN_LISTS, file), 'utf8');
    const title = markdown.match(/^title:\s*(.+)$/m)?.[1]?.trim() || file.replace(/\.md$/, '');
    const bucket = classifyFile(file);
    const symbols = extractTickers(markdown);
    lists.push({ file, title, bucket, count: symbols.length, symbols });
    for (const symbol of symbols) {
      if (!bySymbol[symbol]) {
        bySymbol[symbol] = { symbol, lists: [], buckets: [] };
      }
      bySymbol[symbol].lists.push(title);
      if (!bySymbol[symbol].buckets.includes(bucket)) {
        bySymbol[symbol].buckets.push(bucket);
      }
    }
  }

  const rank = { primary: 0, highBeta: 1, tactical: 2, other: 3 };
  const symbols = Object.values(bySymbol).sort((a, b) => {
    const ra = Math.min(...a.buckets.map((bucket) => rank[bucket] ?? 9));
    const rb = Math.min(...b.buckets.map((bucket) => rank[bucket] ?? 9));
    return ra - rb || a.symbol.localeCompare(b.symbol);
  });

  if (!symbols.length) return demoResearchUniverse();
  return { lists, symbols, bySymbol, error: null, fallback: null, note: null };
}
