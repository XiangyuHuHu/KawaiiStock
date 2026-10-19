import { chinaPaperSession, regularPaperSession } from './sessions.js';

export function daemonIntervalMin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(60, Math.max(5, Math.round(n)));
}

/** 两个市场都关着时，跳到下一次开市；已经开着就返回 now。步长 1 分钟，避免跨过 9:30。 */
export function nextSessionOpen(now = Date.now(), stepMs = 60_000) {
  if (chinaPaperSession(now) || regularPaperSession(now)) return now;
  const limit = now + 8 * 24 * 60 * 60 * 1000;
  for (let t = now + stepMs; t <= limit; t += stepMs) {
    if (chinaPaperSession(t) || regularPaperSession(t)) return t;
  }
  return null;
}

export function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener?.('abort', stop, { once: true });
  });
}
