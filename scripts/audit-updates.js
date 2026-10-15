// Read-only HTTP audit: never calls refresh=1, POST, PUT, DELETE, run or reset.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REPORTS_DIR,ROOT } from '../src/paths.js';
const base=process.env.AUDIT_BASE_URL || 'http://127.0.0.1:3479';
const paths=[
  '/api/health','/api/accounts?desk=chatgpt','/api/accounts?desk=grok','/api/compare',
  ...['grok','chatgpt'].flatMap(desk=>['main','tactical','agentic'].map(account=>`/api/desk?desk=${desk}&account=${account}`)),
  '/api/tape?desk=chatgpt&account=tactical','/api/stocks?pageSize=1','/api/stocks?market=cn&pageSize=1','/api/universe',
  '/api/reports','/api/recommendations?advisor=chatgpt','/api/recommendations?advisor=grok',
  '/api/actuals?advisor=chatgpt','/api/actuals?advisor=grok',
  '/api/oracle/current?scope=all','/api/oracle/symbols?market=us','/api/oracle/symbols?market=cn',
  '/api/oracle/accuracy?market=us','/api/oracle/accuracy?market=cn','/api/oracle',
  '/api/agentic-brief','/api/guards','/api/events','/api/review?advisor=chatgpt','/api/review?advisor=grok',
  '/api/watchlist','/api/watchlist/cn','/api/watch-score','/api/cycle?symbol=SPY',
  '/api/risk','/api/paper?all=1','/api/sim','/api/strategy/validation',
  '/api/accounts/main/holdings?desk=chatgpt','/api/accounts/agentic/holdings?desk=grok',
  '/api/accounts/main/strategy?desk=chatgpt',
  '/api/tradable?desk=chatgpt&account=main','/api/posters?desk=chatgpt&account=tactical'
];
const results=[];
function summarize(p){
  if(Array.isArray(p))return {count:p.length,latestDate:p[0]?.date||null,latestStale:p[0]?.stale??null};
  const out={};
  for(const key of ['ok','date','asOf','dataAsOf','marketDataAsOf','fundamentalsAsOf','stale','empty','unscanned','cached','generatedAt','updatedAt','counts','scanned','note','error','errors','partial','collector','provider','status','observationDate'])if(p?.[key]!=null)out[key]=p[key];
  if(p?.holdings)out.holdings={asOf:p.holdings.asOf,dataAsOf:p.holdings.dataAsOf,stale:p.holdings.stale};
  if(p?.latestRec)out.recommendation={date:p.latestRec.date,source:p.latestRec.json?.source};
  if(p?.quotes)out.quotes=Object.values(p.quotes).map(q=>({symbol:q.symbol,ok:q.ok,asOf:q.asOf,quoteAt:q.quoteAt,error:q.error}));
  if(p?.summary)out.summary=p.summary;
  if(p?.collection)out.collection=p.collection;
  return out;
}
async function probe(path){
  if(/refresh=|\/run|\/reset/.test(path))throw Error('Read-only path required');
  const start=Date.now();
  try {
    const r=await fetch(base+path,{signal:AbortSignal.timeout(45000)});
    const p=await r.json();
    const result={path,http:r.status,ms:Date.now()-start,data:summarize(p)};
    results.push(result);console.log(JSON.stringify({path,http:r.status,ms:result.ms,ok:p.ok,empty:p.empty,error:p.error}));
  }catch(e){results.push({path,http:null,ms:Date.now()-start,error:e.name==='TimeoutError'?'45 秒超时':e.message});console.log(JSON.stringify(results.at(-1)));}
}
const start=Date.now();
let cursor=0;
await Promise.all(Array.from({length:4},async()=>{while(cursor<paths.length){const path=paths[cursor++];await probe(path);}}));
const server=await readFile(join(ROOT,'server.js'),'utf8');
const routeInventory=[...new Set([...server.matchAll(/url\.pathname === '([^']+)'/g)].map(m=>m[1]))];
const report={startedAt:new Date(start).toISOString(),completedAt:new Date().toISOString(),base,readOnly:true,
  note:'HTTP 成功不等于数据新鲜或已有自动调度。生成/保存/下单/结算/重置接口仅审查代码，未触发。',routeInventory,results};
const dir=join(REPORTS_DIR,'research');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'updates-api-audit-20260923.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({probed:results.length,httpFailures:results.filter(r=>r.http!==200).length,elapsedMs:Date.now()-start}));
