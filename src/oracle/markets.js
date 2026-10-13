import { chinaStamp, todayStamp, isUsSessionDay } from '../paths.js';
import { sessionOpenMs } from '../market-time.js';
import { sessionCloseMs, nextSessionDate } from '../options/time.js';

// SSE 2026 holiday notice: https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const holidays = [['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function isChinaOracleSession(day) {
  if(!/^2026-\d{2}-\d{2}$/.test(day||''))return false;
  const d=new Date(`${day}T12:00:00+08:00`), dow=d.getUTCDay();
  return Number.isFinite(d.getTime())&&chinaStamp(d)===day&&dow!==0&&dow!==6&&!holidays.some(([a,b])=>day>=`2026-${a}`&&day<=`2026-${b}`);
}
export function nextChinaOracleSession(day) {
  const d=new Date(`${day}T12:00:00+08:00`);
  for(let i=0;i<20;i++){d.setUTCDate(d.getUTCDate()+1);const next=chinaStamp(d);if(!next.startsWith('2026-'))return null;if(isChinaOracleSession(next))return next;}
  return null;
}
const markets={
  us:{id:'us',label:'美股',timeZone:'America/New_York',timeLabel:'ET',method:'meihua-symbol-v1',today:todayStamp,
    validSymbol:s=>/^[A-Z][A-Z0-9.-]{0,14}$/.test(s),supported:day=>/^202[56]-/.test(day||'')&&isUsSessionDay(day),
    calendarSupported:day=>/^202[56]-/.test(day||''),cutoff:sessionOpenMs,close:sessionCloseMs,next:nextSessionDate,cutoffLabel:'09:30 ET',closeLabel:'美东收盘后 15 分钟'},
  cn:{id:'cn',label:'A 股',timeZone:'Asia/Shanghai',timeLabel:'北京时间',method:'meihua-cn-v1',today:chinaStamp,
    validSymbol:s=>/^[034689]\d{5}$/.test(s),supported:isChinaOracleSession,calendarSupported:day=>/^2026-/.test(day||''),
    cutoff:day=>Date.parse(`${day}T09:15:00+08:00`),close:day=>Date.parse(`${day}T15:00:00+08:00`),next:nextChinaOracleSession,cutoffLabel:'09:15 北京时间（集合竞价前）',closeLabel:'15:15 北京时间'}
};
export function oracleMarket(id='us'){if(!markets[id])throw Error('市场仅支持 us / cn');return markets[id];}
