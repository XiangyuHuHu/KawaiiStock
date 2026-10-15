import { emaSeries } from '../levels.js';

function isoWeekKey(date) {
  const cursor = new Date(`${date}T00:00:00Z`);
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((cursor - yearStart) / 86400000) + 1) / 7);
  return `${cursor.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 只保留已经走完的周。最后一周如果不是周五收盘，整周丢掉。 */
export function completedWeeklyBars(dailyBars) {
  const groups = new Map();
  for (const bar of dailyBars || []) {
    if (!bar?.date || !(bar.close > 0)) continue;
    const key = isoWeekKey(bar.date);
    const rows = groups.get(key) || [];
    rows.push(bar);
    groups.set(key, rows);
  }
  const keys = [...groups.keys()];
  const weekly = [];
  keys.forEach((key, index) => {
    const days = groups.get(key);
    const last = days[days.length - 1];
    const lastWeek = index === keys.length - 1;
    if (lastWeek && weekday(last.date) !== 5) return;
    weekly.push({
      date: last.date,
      week: key,
      open: days[0].open,
      high: Math.max(...days.map((day) => day.high)),
      low: Math.min(...days.map((day) => day.low)),
      close: last.close,
      volume: days.reduce((total, day) => total + (day.volume || 0), 0),
      complete: true
    });
  });
  return {
    bars: weekly,
    incompleteWeeklyDropped: keys.length > weekly.length
  };
}

export function timeframeTrend(bars) {
  const closes = (bars || []).map((bar) => bar.close).filter((value) => value > 0);
  if (closes.length < 20) return { trend: 'unavailable', reason: 'bars-short', ema20: null, ema50: null };
  const ema20s = emaSeries(closes, 20);
  const ema20 = ema20s[ema20s.length - 1];
  const prevEma20 = ema20s[ema20s.length - 2];
  const ema50 = closes.length >= 50 ? emaSeries(closes, 50).at(-1) : null;
  const last = closes[closes.length - 1];
  let trend = 'flat';
  if (ema50 != null) {
    if (last > ema20 && ema20 > ema50) trend = 'up';
    else if (last < ema20 && ema20 < ema50) trend = 'down';
  } else if (last > ema20 && ema20 > prevEma20) trend = 'up';
  else if (last < ema20 && ema20 < prevEma20) trend = 'down';
  return { trend, ema20, ema50, last, bars: closes.length };
}

export function assessMtf({ daily, weekly, hourly } = {}) {
  const weeklyPack = weekly ? { bars: weekly, incompleteWeeklyDropped: false } : completedWeeklyBars(daily);
  const dailyTrend = timeframeTrend(daily);
  const weeklyTrend = timeframeTrend(weeklyPack.bars);
  const hourlyTrend = hourly?.length ? timeframeTrend(hourly) : { trend: 'unavailable', reason: 'not-provided', ema20: null, ema50: null };
  const confirmed = dailyTrend.trend === 'up'
    && weeklyTrend.trend === 'up'
    && (hourlyTrend.trend === 'unavailable' || hourlyTrend.trend === 'up' || hourlyTrend.trend === 'flat');
  return {
    daily: dailyTrend.trend,
    weekly: weeklyTrend.trend,
    hourly: hourlyTrend.trend,
    confirmed,
    incompleteWeeklyDropped: weeklyPack.incompleteWeeklyDropped,
    weeklyBarsUsed: weeklyPack.bars.length,
    dailyEma20: dailyTrend.ema20,
    weeklyEma20: weeklyTrend.ema20
  };
}
