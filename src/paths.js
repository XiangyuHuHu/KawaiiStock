import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DATA_DIR = process.env.KAWAII_DATA_DIR || join(ROOT, 'data');
export const REPORTS_DIR = process.env.KAWAII_REPORTS_DIR || join(ROOT, 'reports');
export const CONFIG_PATH = join(DATA_DIR, 'accounts.json');

export const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(ROOT, 'vault', 'grok');
export const OBSIDIAN_CHATGPT = process.env.OBSIDIAN_CHATGPT || join(ROOT, 'vault', 'chatgpt');
export const OBSIDIAN_LISTS = process.env.OBSIDIAN_LISTS || join(ROOT, 'vault', 'lists', 'us');
export const OBSIDIAN_CN_LISTS = process.env.OBSIDIAN_CN_LISTS || join(ROOT, 'vault', 'lists', 'cn');
export const OBSIDIAN_HOLDINGS = process.env.OBSIDIAN_HOLDINGS || join(ROOT, 'vault', 'holdings');

export const VAULT_PATHS = [
  ['OBSIDIAN_VAULT', OBSIDIAN_VAULT],
  ['OBSIDIAN_CHATGPT', OBSIDIAN_CHATGPT],
  ['OBSIDIAN_LISTS', OBSIDIAN_LISTS],
  ['OBSIDIAN_CN_LISTS', OBSIDIAN_CN_LISTS],
  ['OBSIDIAN_HOLDINGS', OBSIDIAN_HOLDINGS]
];

/** 启动时记下还不存在的资料目录。缺目录不阻止研究台起来。 */
export async function logMissingPaths(logger = console) {
  const rows = [];
  for (const [name, dir] of VAULT_PATHS) {
    let missing = false;
    try {
      await access(dir);
    } catch {
      missing = true;
      logger.warn?.(`[kawaii] 路径不存在 ${name}=${dir}`);
    }
    rows.push({ name, path: dir, missing });
  }
  return rows;
}

/** Agentic 叙事日志，不是买卖清单。 */
export const OBSIDIAN_DAILY = process.env.OBSIDIAN_DAILY || join(OBSIDIAN_VAULT, '日报');

export const OBSIDIAN_RECS = process.env.OBSIDIAN_RECS || join(OBSIDIAN_VAULT, '推荐操作');
export const OBSIDIAN_CHATGPT_RECS = process.env.OBSIDIAN_CHATGPT_RECS || join(OBSIDIAN_CHATGPT, '推荐操作');
export const OBSIDIAN_SIM = process.env.OBSIDIAN_SIM || join(OBSIDIAN_VAULT, '模拟操作');
export const OBSIDIAN_CHATGPT_SIM = process.env.OBSIDIAN_CHATGPT_SIM || join(OBSIDIAN_CHATGPT, '模拟操作');
export const OBSIDIAN_ACTUALS = process.env.OBSIDIAN_ACTUALS || join(OBSIDIAN_VAULT, '实际操作');
export const OBSIDIAN_CHATGPT_ACTUALS = process.env.OBSIDIAN_CHATGPT_ACTUALS || join(OBSIDIAN_CHATGPT, '实际操作');
/** 价位图海报。独立于推荐/模拟/实际操作。 */
export const OBSIDIAN_POSTERS = process.env.OBSIDIAN_POSTERS || join(OBSIDIAN_VAULT, '价位图');
/** 每日可买卖草稿。不是下单，也不进模拟引擎。 */
export const OBSIDIAN_TRADES = process.env.OBSIDIAN_TRADES || join(OBSIDIAN_VAULT, '今日买卖');
/** 期权推荐草稿。独立于推荐/模拟/实际操作，不是下单指令。缺文件不让每日任务失败。 */
export const OBSIDIAN_OPTIONS = process.env.OBSIDIAN_OPTIONS || join(OBSIDIAN_VAULT, '期权推荐');
/** Phase 0 纸上实验仓。独立账本，不写模拟操作，缺文件不让每日任务失败。 */
export const OBSIDIAN_PAPER = process.env.OBSIDIAN_PAPER || join(OBSIDIAN_VAULT, '纸上实验');
/** 每日观察板。足迹不是预测，不是下单。不进推荐/模拟/实际操作。缺文件不让每日任务失败。 */
export const OBSIDIAN_WATCH = process.env.OBSIDIAN_WATCH || join(OBSIDIAN_VAULT, '每日观察');
/** 奇门/算卦对照。研究娱乐，不是下单。不进推荐/模拟/实际操作。缺文件不让每日任务失败。 */
export const OBSIDIAN_ORACLE = process.env.OBSIDIAN_ORACLE || join(OBSIDIAN_VAULT, '算卦');
/** Agentic 操作意见。综合观察/算卦/期权/推荐，不是下单。不进推荐/模拟/实际操作。缺文件不让每日任务失败。 */
export const OBSIDIAN_BRIEF = process.env.OBSIDIAN_BRIEF || join(OBSIDIAN_VAULT, 'Agentic意见');
export const SIM_DIR = join(DATA_DIR, 'sim');
export const ACTUALS_DIR = join(DATA_DIR, 'actuals');

export function recsDir(advisor = 'grok') {
  return advisor === 'chatgpt' ? OBSIDIAN_CHATGPT_RECS : OBSIDIAN_RECS;
}

export function recsLegacyDir(advisor = 'grok') {
  const root = advisor === 'chatgpt' ? OBSIDIAN_CHATGPT : OBSIDIAN_VAULT;
  return join(root, '推荐');
}

export function simVaultDir(advisor = 'grok') {
  return advisor === 'chatgpt' ? OBSIDIAN_CHATGPT_SIM : OBSIDIAN_SIM;
}

export function actualsDir(advisor = 'grok') {
  return advisor === 'chatgpt' ? OBSIDIAN_CHATGPT_ACTUALS : OBSIDIAN_ACTUALS;
}

export function strategyRoot(vault = 'grok') {
  return vault === 'chatgpt' ? OBSIDIAN_CHATGPT : OBSIDIAN_VAULT;
}

export function todayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((row) => row.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 美东日历日所在周的周一。Risk Gateway 周亏窗口用这个。 */
export function weekStamp(date = new Date()) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : todayStamp(date);
  const [y, m, d] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const weekday = utc.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  utc.setUTCDate(utc.getUTCDate() - back);
  return utc.toISOString().slice(0, 10);
}

/** 美东周末 + 常见休市。用来找「最近一个该有观察板的交易日」。 */
const US_MARKET_CLOSED = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'
]);
export const US_CALENDAR_THROUGH = '2028-12-31';

/** 休市日表快到期（≤60 天）或已过期时给警告，避免把休市日当成交易日。 */
export function calendarWarning(today = todayStamp()) {
  const days = Math.round((Date.parse(`${US_CALENDAR_THROUGH}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (days < 0) return `美股休市日表只到 ${US_CALENDAR_THROUGH}，已过期：休市日会被当成交易日，请补 src/paths.js`;
  if (days <= 60) return `美股休市日表只到 ${US_CALENDAR_THROUGH}，还剩 ${days} 天，请补下一年`;
  return null;
}

function etWeekday(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short'
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 0;
}

export function isUsSessionDay(stamp) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp || '')) return false;
  if (US_MARKET_CLOSED.has(stamp)) return false;
  const probe = new Date(`${stamp}T12:00:00-05:00`);
  const dow = etWeekday(Number.isNaN(probe.getTime()) ? new Date() : probe);
  return dow !== 0 && dow !== 6;
}

/** 最近一个美股交易日（美东）。周末 / 节假日回退到上一交易日。 */
export function lastSessionStamp(date = new Date()) {
  let cursor = new Date(date);
  for (let i = 0; i < 10; i += 1) {
    const stamp = todayStamp(cursor);
    const dow = etWeekday(cursor);
    if (dow !== 0 && dow !== 6 && !US_MARKET_CLOSED.has(stamp)) return stamp;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return todayStamp(date);
}

export function chinaStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((row) => row.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shanghaiWeekday(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short'
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 0;
}

/** 最近一个 A 股交易日（北京）。周末回退；节假日未单独表，缺文件会显示最近一次。 */
export function lastChinaSessionStamp(date = new Date()) {
  let cursor = new Date(date);
  for (let i = 0; i < 10; i += 1) {
    const stamp = chinaStamp(cursor);
    const dow = shanghaiWeekday(cursor);
    if (dow !== 0 && dow !== 6) return stamp;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return chinaStamp(date);
}

/** 把 asOf / ISO / 文件名收成美东 YYYY-MM-DD。解析失败返回 null。 */
export function asOfStamp(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct && !text.includes('T') && text.length <= 10) return direct[1];
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return direct ? direct[1] : null;
  }
  return todayStamp(parsed);
}
