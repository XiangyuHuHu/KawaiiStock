import { runPaperOpen } from '../src/paper/auto.js';
import { chinaPaperSession, marketFlags, regularPaperSession } from '../src/paper/sessions.js';
import { daemonIntervalMin, nextSessionOpen, sleepMs } from '../src/paper/schedule.js';

const once = process.argv.includes('--once');
const intervalArg = process.argv.indexOf('--interval');
const intervalMin = daemonIntervalMin(intervalArg >= 0 ? process.argv[intervalArg + 1] : process.env.PAPER_DAEMON_INTERVAL_MIN);
const intervalMs = intervalMin * 60 * 1000;
const controller = new AbortController();

console.log(`纸上实验守护进程。只跑纸上账，不发券商单。间隔 ${intervalMin} 分钟。`);

function stop() {
  controller.abort();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function tick() {
  const flags = marketFlags();
  console.log(`${new Date().toISOString()} markets cn=${flags.cn} us=${flags.us}`);
  const result = await runPaperOpen();
  const summary = Object.entries(result.sessions || {}).map(([id, session]) => {
    const diag = session.diagnostics || {};
    return `${id}:scan${diag.scanned ?? '—'}/buy${diag.ordersPlaced ?? 0}`;
  }).join(' ');
  console.log(`${result.outsideSession ? 'outside' : 'ran'} ${summary}`.trim());
  if (result.reportError) console.error(`report ${result.reportError}`);
}

if (once) {
  await tick();
  process.exit(0);
}

while (!controller.signal.aborted) {
  const now = Date.now();
  if (chinaPaperSession(now) || regularPaperSession(now)) {
    const started = Date.now();
    try {
      await tick();
    } catch (error) {
      console.error(error?.stack || error?.message || error);
    }
    const wait = Math.max(1000, intervalMs - (Date.now() - started));
    await sleepMs(wait, controller.signal);
  } else {
    const next = nextSessionOpen(now);
    const wait = Math.max(1000, (next || now + intervalMs) - Date.now());
    console.log(`两个市场都关着，${Math.round(wait / 1000)} 秒后看下一次开市。`);
    await sleepMs(wait, controller.signal);
  }
}
