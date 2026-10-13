import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { REPORTS_DIR } from '../src/paths.js';
import { loadManyHistoricals } from '../src/historicals.js';
import { closedBars } from '../src/market-time.js';
import { validateWindow } from '../src/strategy/validation.js';
import { STRATEGY_VERSION, RESEARCH_RULES } from '../src/strategy/confirmation.js';

const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
const dir = join(REPORTS_DIR, 'research');
await mkdir(dir, { recursive: true });
// Fixed research universe, not selected using strategy outcomes. Current constituents still imply survivorship bias.
const symbols = (arg('--symbols') || 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,MU,AVGO,PLTR,CRDO,RKLB,ASTS,OKLO,SMR,HIMS,SOFI,SPY,IWM').split(',').map((s) => s.trim().toUpperCase());
let snapshotPath = arg('--snapshot') ? resolve(arg('--snapshot')) : null;
let snapshot;
if (snapshotPath) snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
else {
  console.log(`Fetching ${symbols.length + 1} symbols; no trades or account files will be touched.`);
  const data = await loadManyHistoricals([...symbols, 'QQQ']);
  const now = new Date();
  for (const pack of Object.values(data)) pack.bars = closedBars(pack.bars, now);
  snapshot = { generatedAt: now.toISOString(), requested: symbols, data };
  snapshotPath = join(dir, `dataset-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
}
const data = snapshot.data;
const dates = data.QQQ?.bars?.map((bar) => bar.date) || [];
if (dates.length < 150) throw new Error('QQQ 历史不足 150 个交易日；不生成误导性验证报告');
const split = Math.floor(dates.length * .8);
const windows = [ { name: 'development', start: dates[60], end: dates[split - 1] }, { name: 'holdout', start: dates[split], end: dates.at(-1) } ];
const results = windows.flatMap((window) => ['v1', 'v2'].map((version) => ({ window: window.name, ...validateWindow(data, { ...window, version }) })));
const stress = validateWindow(data, { ...windows[1], version: 'v2', slippageBps: 20 });
const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
const codeFiles = ['src/strategy/cycle.js', 'src/strategy/confirmation.js', 'src/strategy/validation.js', 'src/levels.js', 'src/market-time.js', 'scripts/validate-strategy.js'];
const codeHash = createHash('sha256');
for (const file of codeFiles) codeHash.update(await readFile(new URL(`../${file}`, import.meta.url)));
const report = { generatedAt: new Date().toISOString(), strategyVersion: STRATEGY_VERSION, rules: RESEARCH_RULES, datasetHash: hash, codeHash: codeHash.digest('hex'), snapshotPath,
  status: 'experimental-not-live-validated', decision: '研究结果不自动批准实盘；保留 V1 对照，V2 只作实验候选',
  limitations: ['回顾性时间切分，不是真正未见过的前瞻样本；禁止根据留出期反复调参', '约一年历史与当前固定股票池，存在幸存者及选择偏差', '价格数据未独立核实拆股/分红调整；不是总回报数据', '每天仅收盘计回撤；日内触及止损和止盈按先止损，跳空按开盘价', '5bp/边滑点；另测20bp/边；未计税费、借券费和规模冲击', '不模拟做空和期权；QQQ满仓基准与最高50%股票仓位风险不同', '少于30笔仅作为实现诊断，不认定策略优势；缺数据持仓使用旧价格须关注 staleMarks'],
  coverage: Object.fromEntries(Object.entries(data).map(([symbol, p]) => [symbol, { ok: p.ok, bars: p.bars?.length || 0, source: p.source, error: p.error }])), results, stress };
const immutable = join(dir, `validation-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(immutable, JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(join(dir, 'latest.json'), JSON.stringify(report, null, 2));
const lines = ['# V1 / V2 策略验证', '', `策略：${STRATEGY_VERSION}。状态：实验，未证明实盘盈利。`, '', `数据 SHA256：${hash}`, `代码 SHA256：${report.codeHash}`, '', '| 区间 | 版本 | 成交 | 胜率 | 净收益 | 最大回撤 | 平均R | QQQ | 平均仓位 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...results.map((r) => `| ${r.window} ${r.start}—${r.end} | ${r.version} | ${r.trades} | ${r.winRate ?? '—'}% | ${r.netReturnPct}% | ${r.maxDrawdownPct}% | ${r.expectancyR ?? '—'} | ${r.benchmarkReturnPct}% | ${r.averageExposurePct}% |`), '', `V2 留出期 20bp/边压力测试：净收益 ${stress.netReturnPct}%，最大回撤 ${stress.maxDrawdownPct}%。`, '', '## 限制', '', ...report.limitations.map((s) => `- ${s}`), '', '## 重现', '', `npm run validate:strategy -- --snapshot "${snapshotPath}"`, ''];
await writeFile(join(dir, 'latest.md'), lines.join('\n'));
console.log(JSON.stringify({ report: join(dir, 'latest.md'), results: results.map(({ curve, tradeDetails, ...r }) => r), stress: { trades: stress.trades, netReturnPct: stress.netReturnPct } }, null, 2));
