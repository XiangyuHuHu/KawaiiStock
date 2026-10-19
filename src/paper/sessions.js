import { isChinaSessionDay, isUsSessionDay, todayStamp } from '../paths.js';

/** 美股常规交易时段。纸上美股账本只用这一段，不含盘前盘后。 */
export function regularPaperSession(now = Date.now()) {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short'
  }).formatToParts(now);
  const get = (key) => et.find((part) => part.type === key)?.value;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return !['Sat', 'Sun'].includes(get('weekday')) && isUsSessionDay(todayStamp(new Date(now))) && minute >= 570 && minute < 960;
}

export function shanghaiClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    weekday: get('weekday'),
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + minute
  };
}

/** A 股连续竞价：北京时间 9:30–11:30、13:00–15:00，且当天是交易日。两端收市时刻不算在内。 */
export function chinaPaperSession(now = Date.now()) {
  const clock = shanghaiClock(now);
  if (!isChinaSessionDay(clock.day)) return false;
  const morning = clock.minutes >= 9 * 60 + 30 && clock.minutes < 11 * 60 + 30;
  const afternoon = clock.minutes >= 13 * 60 && clock.minutes < 15 * 60;
  return morning || afternoon;
}

export const PAPER_DESK_MARKET = {
  '0a': 'us',
  '0b': 'us',
  '0c': 'us',
  '0d': 'us',
  '0e': 'us',
  '0f': 'us',
  '0g': 'cn',
  '0h': 'us'
};

export function paperMarketOf(desk) {
  return PAPER_DESK_MARKET[String(desk || '').toLowerCase()] || 'us';
}

export function orderMarket(order = {}) {
  if (order.market === 'cn' || order.desk === '0g') return 'cn';
  if (/^\d{6}$/.test(String(order.symbol || ''))) return 'cn';
  return 'us';
}

export function paperSessionOpen(desk, now = Date.now()) {
  return paperMarketOf(desk) === 'cn' ? chinaPaperSession(now) : regularPaperSession(now);
}

export function desksForSession(desks, now = Date.now()) {
  const open = [];
  const closed = [];
  for (const id of desks || []) {
    (paperSessionOpen(id, now) ? open : closed).push(id);
  }
  return { open, closed };
}

export function marketFlags(now = Date.now()) {
  return { cn: chinaPaperSession(now), us: regularPaperSession(now) };
}
