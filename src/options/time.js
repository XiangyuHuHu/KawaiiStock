import { isUsSessionDay, todayStamp } from '../paths.js';
import { sessionOpenMs } from '../market-time.js';

const EARLY = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24']);
export const sessionCloseMs = day => sessionOpenMs(day) + (EARLY.has(day) ? 210 : 390) * 60000;
export function regularSession(now = Date.now()) {
  const day = todayStamp(new Date(now));
  return /^202[56]-/.test(day) && isUsSessionDay(day) && now >= sessionOpenMs(day) && now < sessionCloseMs(day);
}

export function nextSessionDate(date) {
  const cursor = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(cursor.getTime())) return null;
  for (let i = 0; i < 10; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.toISOString().slice(0, 10);
    if (!/^202[56]-/.test(day)) return null;
    if (isUsSessionDay(day)) return day;
  }
  return null;
}

// Trading minutes for 60m; third subsequent session at the same clock time for 3d.
export function horizonTarget(start, horizon) {
  let cursor = Number(start);
  if (!(cursor > 0) || !['60m', '3d'].includes(horizon)) return null;
  if (!regularSession(cursor)) return null;
  if (horizon === '3d') {
    let day = todayStamp(new Date(cursor));
    const offset = cursor - sessionOpenMs(day);
    for (let i = 0; i < 3; i++) { day = nextSessionDate(day); if (!day) return null; }
    return Math.min(sessionOpenMs(day) + offset, sessionCloseMs(day));
  }
  let remaining = 60;
  for (let i = 0; i < 12; i++) {
    const day = todayStamp(new Date(cursor));
    const open = sessionOpenMs(day), close = sessionCloseMs(day);
    if (isUsSessionDay(day) && cursor < close) {
      cursor = Math.max(cursor, open);
      const available = (close - cursor) / 60000;
      if (remaining <= available) return cursor + remaining * 60000;
      remaining -= available;
    }
    const next = nextSessionDate(day);
    if (!next) return null;
    cursor = sessionOpenMs(next);
  }
  return null;
}
