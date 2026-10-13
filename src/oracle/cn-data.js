import { loadChinaWatchlists } from '../screener/cn-market-data.mjs';
import { oracleMarket } from './markets.js';
import { chinaStamp } from '../paths.js';

export async function chinaOracleUniverse(){
  const lists=await loadChinaWatchlists(), rows=new Map();
  for(const list of lists)for(const r of list.stocks||[]){
    if(!oracleMarket('cn').validSymbol(r.symbol))continue;
    const old=rows.get(r.symbol);
    if(old)old.from+=`、${list.title}`;else rows.set(r.symbol,{symbol:r.symbol,name:r.company,from:list.title});
  }
  return [...rows.values()];
}
const number=v=>v==null||String(v).trim()===''?null:Number.isFinite(Number(v))?Number(v):null;
export function parseChinaDaily(data,symbol){
  if(String(data?.code)!==symbol||!Array.isArray(data.klines))return {ok:false,source:'eastmoney-daily-unadjusted',bars:[]};
  return {ok:true,source:'eastmoney-daily-unadjusted',bars:data.klines.map(line=>{
    const [date,open,close,high,low,volume]=String(line).split(',');
    return {date,open:number(open),close:number(close),high:number(high),low:number(low),volume:number(volume)};
  })};
}
export async function loadChinaOracleHistory(symbol,{fetcher=fetch}={}){
  if(!oracleMarket('cn').validSymbol(symbol))throw Error('A 股代码无效');
  const secid=`${symbol.startsWith('6')?1:0}.${symbol}`;
  const query=new URLSearchParams({secid,klt:'101',fqt:'0',beg:'20260101',end:'20261231',lmt:'500',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56'});
  try{
    const r=await fetcher(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${query}`,{headers:{Referer:'https://quote.eastmoney.com/','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('行情不可用');
    const parsed=parseChinaDaily((await r.json()).data,symbol);if(parsed.ok&&parsed.bars.length)return parsed;
  }catch{/* Read-only fallback uses unadjusted daily rows, never a current quote. */}
  const code=`${symbol.startsWith('6')?'sh':/^[03]/.test(symbol)?'sz':'bj'}${symbol}`;
  try{
    const r=await fetcher(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,500,`,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('行情不可用');
    const data=(await r.json()).data?.[code]?.day;
    if(!Array.isArray(data)||!data.length)throw Error('无日线');
    return {ok:true,source:'tencent-daily-unadjusted',bars:data.map(([date,open,close,high,low,volume])=>({date,open:number(open),close:number(close),high:number(high),low:number(low),volume:number(volume)}))};
  }catch{/* Try provider daily OHLC, never substitute a current quote. */}
  const yahoo=`${symbol}.${code.startsWith('sh')?'SS':code.startsWith('sz')?'SZ':'BJ'}`;
  try{
    const r=await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${yahoo}?range=1y&interval=1d&includePrePost=false`,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('行情不可用');
    const p=(await r.json()).chart?.result?.[0],q=p?.indicators?.quote?.[0];
    if(p?.meta?.symbol!==yahoo||!Array.isArray(p.timestamp)||!q)throw Error('合约代码或日线缺失');
    return {ok:true,source:'yahoo-cn-daily-unadjusted',bars:p.timestamp.map((t,i)=>({date:chinaStamp(new Date(t*1000)),open:number(q.open?.[i]),close:number(q.close?.[i]),high:number(q.high?.[i]),low:number(q.low?.[i]),volume:number(q.volume?.[i])}))};
  }catch{return {ok:false,source:null,bars:[],error:'A 股完整日线暂不可用；停牌或缺日线不结算'};}
}
