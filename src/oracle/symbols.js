import { createHash } from 'node:crypto';
import { optionUniverse } from '../options/engine.js';
import { oracleMarket } from './markets.js';
import { chinaOracleUniverse } from './cn-data.js';

export const METHOD = 'meihua-symbol-v1';
export const SOURCES = [
  { title: '《梅花易数》卷二 · 体用生克', url: 'https://zh.wikisource.org/zh-hans/梅花易數/卷二' },
  { title: '《易传·说卦》· 八卦取象', url: 'https://zh.wikisource.org/zh-hans/周易/說卦' }
];
// Lines are stored from bottom to top. This is a documented program casting rule,
// not a traditional calendar calculation and not evidence of future market returns.
const TRIGRAMS = [
  ['乾','天','金',[1,1,1]], ['兑','泽','金',[1,1,0]],
  ['离','火','火',[1,0,1]], ['震','雷','木',[1,0,0]],
  ['巽','风','木',[0,1,1]], ['坎','水','水',[0,1,0]],
  ['艮','山','土',[0,0,1]], ['坤','地','土',[0,0,0]]
].map(([name,image,element,lines], i)=>({name,image,element,lines,number:i+1}));
const generates={木:'火',火:'土',土:'金',金:'水',水:'木'};
const controls={木:'土',土:'水',水:'火',火:'金',金:'木'};
const trigram=lines=>TRIGRAMS.find(t=>t.lines.every((v,i)=>v===lines[i]));
export function validOracleDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  const d=new Date(`${day}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===day;
}
export function relation(body, use) {
  if(body===use)return {label:'体用比和',value:1,meaning:'同气相应，取平顺之象'};
  if(generates[use]===body)return {label:'用生体',value:2,meaning:'外来生扶，取助力之象'};
  if(generates[body]===use)return {label:'体生用',value:-1,meaning:'自身外泄，取消耗之象'};
  if(controls[use]===body)return {label:'用克体',value:-2,meaning:'外来克制，取受压之象'};
  return {label:'体克用',value:0,meaning:'克制需费力，取进展有阻之象'};
}
function hexagram(lines) {
  const lower=trigram(lines.slice(0,3)), upper=trigram(lines.slice(3));
  return {lines,lower,upper,label:`上${upper.name}下${lower.name}（${upper.image}/${lower.image}）`};
}
export function interpret(upperNumber, lowerNumber, movingLine) {
  if (![upperNumber,lowerNumber].every(n=>Number.isInteger(n)&&n>=1&&n<=8)||!Number.isInteger(movingLine)||movingLine<1||movingLine>6)throw Error('起卦数值无效');
  const upper=TRIGRAMS[upperNumber-1], lower=TRIGRAMS[lowerNumber-1];
  const original=hexagram([...lower.lines,...upper.lines]);
  const changedLines=[...original.lines];changedLines[movingLine-1]^=1;
  const changed=hexagram(changedLines);
  const mutual=hexagram([...original.lines.slice(1,4),...original.lines.slice(2,5)]);
  const body=movingLine<=3?upper:lower, use=movingLine<=3?lower:upper;
  const changedUse=movingLine<=3?changed.lower:changed.upper;
  const start=relation(body.element,use.element), end=relation(body.element,changedUse.element);
  const conflict=start.value*end.value<0, total=start.value+end.value;
  const direction=conflict?'neutral':total>=2?'up':total<=-2?'down':'neutral';
  return {original,changed,mutual,movingLine,body,use,start,end,direction,
    reason:`本卦${start.label}：${start.meaning}；变卦${end.label}：${end.meaning}。${conflict?'前后方向相反，列入分歧观望。':direction==='up'?'生扶较多，程序映射为卦象偏涨。':direction==='down'?'克泄较多，程序映射为卦象偏跌。':'支持方向不足，列入观望。'}`};
}
export function castSymbol(symbol, date, market = 'us') {
  const config=oracleMarket(market);
  const code=String(symbol).trim().toUpperCase();
  if(!config.validSymbol(code)||!validOracleDay(date))throw Error('标的或观察日无效');
  const hash=createHash('sha256').update(`${config.method}|${date}|${code}`).digest();
  const upper=hash.readUInt32BE(0)%8+1,lower=hash.readUInt32BE(4)%8+1,moving=hash.readUInt32BE(8)%6+1;
  return {symbol:code,seed:hash.toString('hex').slice(0,12),...interpret(upper,lower,moving)};
}
export async function buildSymbolOracle({date,now=Date.now(),universeLoader,market='us'}={}) {
  const config=oracleMarket(market);
  const day=date||config.today(new Date(now));
  if(!validOracleDay(day))throw Error('观察日必须是有效的 YYYY-MM-DD');
  const universe=await (universeLoader||(market==='cn'?chinaOracleUniverse:optionUniverse))({full:true});
  const unique=[...new Map(universe.map(row=>[String(row.symbol).toUpperCase(),row])).values()];
  const rows=unique.map(row=>({...castSymbol(row.symbol,day,market),name:row.name||row.symbol,from:row.from}));
  const poolNote=universe.poolNote||null;
  return {ok:true,date:day,market,marketLabel:config.label,timeZone:config.timeZone,timeLabel:config.timeLabel,generatedAt:new Date(now).toISOString(),method:config.method,liveTrading:false,
    retrospective:day<config.today(new Date(now)),sessionDay:config.supported(day),calendarSupported:config.calendarSupported(day),rows,
    counts:Object.fromEntries(['up','down','neutral'].map(key=>[key,rows.filter(r=>r.direction===key).length])),sources:SOURCES,
    poolNote,poolSource:universe.poolSource||null,
    scope:market==='cn'?'A 股 List 全部股票去重后逐个起卦；与美股独立统计。':(poolNote||'现有期权研究观察池（研究持仓及关注名单），去重后逐个起卦。'),
    note:'娱乐卦象分组，不是可验证的股价预测，没有胜率或收益承诺，不生成买卖订单。',
    methodology:'自定义数字起卦：规则版本 + 市场当地观察日 + 大写股票代码经 SHA-256，前三个 32 位数分别模 8、8、6 后加 1，得到上卦、下卦、动爻。静卦为体、动卦为用；互卦取二三四、三四五爻，变卦翻转动爻。体用比和 +1、用生体 +2、体生用 −1、用克体 −2、体克用 0；本卦与变卦异号则观望，否则合计 ≥2 偏涨、≤−2 偏跌，其余观望。数值只是本程序的分类规则，非概率；互卦仅展示，不参与方向评分。这不是传统时间起卦，也不是奇门自动排盘。刷新不会换种子、不会根据已知行情倒改卦象。'};
}
