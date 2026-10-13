import { todayStamp } from './paths.js';

export function sessionClosed(day, now = new Date()) {
  const today = todayStamp(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric' }).format(now));
  return Boolean(day && (day < today || (day === today && hour >= 16)));
}

export function sessionOpenMs(day) {
  const noon = new Date(`${day}T12:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric' }).format(noon));
  return Date.parse(`${day}T00:00:00Z`) + (9.5 + 12 - hour) * 3600000;
}

export function closedBars(bars, now = new Date()) {
  return (bars || []).filter((bar) => sessionClosed(bar.date, now));
}
