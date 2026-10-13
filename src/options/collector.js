import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_OPTIONS } from '../paths.js';
import { refreshForward } from './forward.js';

export function createCollector({ refresh = refreshForward, intervalMs = 30000, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null, flight = null;
  const state = { enabled: false, running: false, intervalMs, startedAt: null, lastStartedAt: null, lastCompletedAt: null, nextRunAt: null, lastError: null, lastCollection: null };
  function arm(delay = intervalMs) {
    if (!state.enabled || timer != null || flight) return;
    state.nextRunAt = new Date(now() + delay).toISOString();
    timer = schedule(() => { timer = null; run(); }, delay);
    timer?.unref?.();
  }
  function run() {
    if (flight) return flight;
    if (timer != null) { cancel(timer); timer = null; }
    state.running = true; state.lastStartedAt = new Date(now()).toISOString(); state.nextRunAt = null;
    flight = Promise.resolve().then(refresh).then(result => {
      state.lastCompletedAt = new Date(now()).toISOString(); state.lastCollection = result.collection || null;
      state.lastError = result.errors?.length ? result.errors.join('；') : null;
      return result;
    }).catch(() => { state.lastError = '采集轮次失败，原有记录保留；下一轮重试'; return null; }).finally(() => {
      state.running = false; flight = null; arm();
    });
    return flight;
  }
  return {
    start() { state.enabled = true; state.startedAt ||= new Date(now()).toISOString(); arm(0); },
    stop() { state.enabled = false; if (timer != null) cancel(timer); timer = null; state.nextRunAt = null; },
    run,
    status() { return structuredClone({ ...state, scope: '只读行情采集；服务运行时每轮检查已保存的待观察记录，不扫描新推荐、不下单' }); }
  };
}

export const forwardCollector = createCollector();
const settingsPath = join(OBSIDIAN_OPTIONS, 'collector-settings.json');
let controlQueue = Promise.resolve();
export async function initializeCollector() {
  let enabled = process.env.OPTIONS_FORWARD_ENABLED !== '0';
  try { const settings = JSON.parse(await readFile(settingsPath, 'utf8')); if (typeof settings.enabled === 'boolean') enabled = settings.enabled; } catch { /* default only; no fabricated collection history */ }
  if (enabled) forwardCollector.start();
  return forwardCollector.status();
}
export function configureCollector(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
  const run = controlQueue.then(async () => {
    await mkdir(OBSIDIAN_OPTIONS, { recursive: true });
    await writeFile(`${settingsPath}.tmp`, JSON.stringify({ enabled }), 'utf8');
    await rename(`${settingsPath}.tmp`, settingsPath);
    if (enabled) forwardCollector.start(); else forwardCollector.stop();
    return forwardCollector.status();
  });
  controlQueue = run.catch(() => {}); return run;
}
