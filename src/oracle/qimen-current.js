import { createHash } from 'node:crypto';
import { generateChartByDatetime, chartToObject } from 'qimen-dunjia';
import { sharedOracleUniverse } from './pool.js';
import { chinaOracleUniverse } from './cn-data.js';

export const QIMEN_METHOD = 'qimen-current-3.1.0-symbol-palace-v1';
const IDS = ['xun','li','kun','zhen','zhong','dui','gen','kan','qian'];
const NUMBERS = [4,9,2,3,5,7,8,1,6];
const OUTER = [0,1,2,3,5,6,7,8];
const DOORS = { '開門': 2, '生門': 2, '休門': 1, '景門': 0, '杜門': 0, '傷門': -1, '驚門': -1, '死門': -2 };
export const QIMEN_SECTORS = [
  { id: 'power', name: '核能 / 电力', names: ['OKLO', 'SMR', 'NNE', 'UEC', 'CCJ', 'BE', 'CEG', 'VST'] },
  { id: 'chip', name: '芯片', names: ['MU', 'MRVL', 'CRDO', 'INTC', 'NVDA', 'AVGO', 'TSM', 'AMAT', 'LRCX'] },
  { id: 'ai', name: 'AI', names: ['NBIS', 'ORCL', 'IREN', 'PLTR', 'MSFT', 'AMZN', 'GOOGL', 'META'] },
  { id: 'cyber', name: '网络安全', names: ['PANW', 'CRWD', 'ZS', 'NET'] },
  { id: 'cooling', name: '散热 / 光', names: ['AAON', 'MOD', 'VRT', 'GLW'] },
  { id: 'space', name: '太空', names: ['RKLB', 'ASTS', 'LUNR'] },
  { id: 'cross', name: '跨资产', names: ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT'] }
];

const CORE = [
  ['SPY','标普 500 ETF'],['QQQ','纳指 100 ETF'],['IWM','罗素 2000 ETF'],
  ['DIA','道指 ETF'],['GLD','黄金 ETF'],['SLV','白银 ETF'],['TLT','长期美债 ETF']
].map(([symbol,name])=>({symbol,name,market:'us',from:'跨资产观察'}));

export async function qimenUniverse(scope, { usLoader=sharedOracleUniverse, cnLoader=chinaOracleUniverse }={}) {
  if (!['all','us','cn'].includes(scope)) throw Error('奇门范围无效');
  const [us,cn]=await Promise.allSettled([
    scope==='cn'?[]:usLoader({full:true}), scope==='us'?[]:cnLoader()
  ]);
  const rows=new Map(), errors=[];
  for(const r of scope==='cn'?[]:CORE)rows.set(`us:${r.symbol}`,r);
  for(const [result,market] of [[us,'us'],[cn,'cn']]) {
    if(result.status==='rejected'){errors.push(`${market==='cn'?'A 股':'美股'}观察池读取失败`);continue;}
    for(const r of result.value) {
      const symbol=String(r.symbol||'').toUpperCase();
      if(!(market==='cn'?/^[034689]\d{5}$/:/^[A-Z][A-Z0-9.-]{0,12}$/).test(symbol))continue;
      rows.set(`${market}:${symbol}`,{symbol,market,name:r.name||r.company||symbol,from:r.from||'现有观察池'});
    }
  }
  return {rows:[...rows.values()],errors};
}

export function currentQimenChart(now=Date.now()) {
  if(!Number.isFinite(now))throw Error('起局时间无效');
  // The upstream engine accepts UTC+8 wall time at hour precision. Explicitly
  // round down and disclose the effective time instead of claiming minute precision.
  const wall=new Date(now+8*3600000).toISOString();
  const key=wall.slice(0,13).replace(/[-T:]/g,'');
  const raw=chartToObject(generateChartByDatetime(key, {定局法:'拆補',夜子時:'次日'}));
  const effectiveAt=Date.parse(wall.slice(0,13)+':00:00+08:00');
  const palaces=IDS.map((id,i)=>({id,num:NUMBERS[i],bagua:raw['方位'][i],men:raw['天門'][i]||'中宫不布门',
    stars:[raw['九星'][i]],heavenStem:raw['天盤'][i],earthStem:raw['地盤'][i],deity:raw['八神'][i]||'中宫不布神',
    yong:raw['天盤'][i]===(raw['時干']==='甲'?raw['符首']:raw['時干'])}));
  return {raw,palaces,effectiveAt,date:wall.slice(0,10),key};
}

export function qimenSymbol(row,palaces) {
  // A disclosed program mapping, not a traditional symbol-specific divination rule.
  const seed=createHash('sha256').update(`${QIMEN_METHOD}|${row.market}|${row.symbol}`).digest().readUInt32BE(0);
  const palace=palaces[OUTER[seed%8]];
  const score=DOORS[palace.men]??0;
  return {...row,palaceId:palace.id,palace:`${palace.bagua}${palace.num}宫`,men:palace.men,
    star:palace.stars[0],heavenStem:palace.heavenStem,earthStem:palace.earthStem,deity:palace.deity,
    direction:score>0?'up':score<0?'down':'neutral',score,
    reason:`程序固定映射至${palace.bagua}${palace.num}宫，本时盘见${palace.men}，按门类规则记 ${score>0?'+':''}${score} 分；不是股价上涨概率。`};
}

/** 板块只是把已有标的宫位汇总。不是另起一盘，也不写未来一个月的阶段。 */
export function qimenSectors(rows = []) {
  return QIMEN_SECTORS.map((sector) => {
    const members = (rows || []).filter((row) => row.market !== 'cn' && sector.names.includes(String(row.symbol || '').toUpperCase()));
    const up = members.filter((row) => row.direction === 'up').length;
    const down = members.filter((row) => row.direction === 'down').length;
    const lean = up > down ? 'up' : down > up ? 'down' : 'neutral';
    return {
      id: sector.id,
      name: sector.name,
      lean,
      up,
      down,
      neutral: members.length - up - down,
      members: members.map((row) => ({ symbol: row.symbol, name: row.name, palace: row.palace, men: row.men, direction: row.direction, score: row.score }))
    };
  }).filter((sector) => sector.members.length);
}

export async function buildCurrentQimen({now=Date.now(),scope='all',universeLoader=qimenUniverse}={}) {
  if(!['all','us','cn'].includes(scope))throw Error('奇门范围无效');
  const chart=currentQimenChart(now);
  const universe=await universeLoader(scope);
  const rows=universe.rows.map(row=>qimenSymbol(row,chart.palaces));
  return {ok:true,mode:'current',liveTrading:false,method:QIMEN_METHOD,scope,date:chart.date,
    generatedAt:new Date(now).toISOString(),effectiveAt:new Date(chart.effectiveAt).toISOString(),
    refreshAfter:new Date(chart.effectiveAt+3600000).toISOString(),chartKey:chart.key,
    chart:{palaces:chart.palaces,shiGan:chart.raw['時干'],yongShen:'时干参考'},
    pillars:['年柱','月柱','日柱','時柱'].map(k=>chart.raw[k]),
    ju:`${chart.raw['陰陽']}遁 ${chart.raw['局數']} 局 · ${chart.raw['節氣']} · ${chart.raw['三元']}`,
    chief:`值符 ${chart.raw['值符']}落${chart.raw['值符落宮']} · 值使 ${chart.raw['值使']}落${chart.raw['值使落宮']}`,
    rows,sectors:qimenSectors(rows),counts:Object.fromEntries(['up','down','neutral'].map(k=>[k,rows.filter(r=>r.direction===k).length])),errors:universe.errors,
    universeCount:rows.length,usCount:rows.filter(row=>row.market!=='cn').length,
    timeZone:'Asia/Shanghai',timeLabel:'北京时间',observationTimeZone:'America/New_York',observationTimeLabel:'美东观察日',
    note:'起局用北京时间（UTC+8）整点，未作真太阳时校正。美股标的的交易日仍标美东。相同小时刷新通常同盘，不随机换盘；跨小时重新计算，仍可能同盘。新盘不依赖行情网络。美股名单与梅花共用去重研究池。',
    methodology:'排盘采用 qimen-dunjia 3.1.0 的拆补法（节气交接起算每五天一元）、夜子时按次日。标的按市场+代码的 SHA-256 固定映射八个外围宫；这是自定义观察规则，不是传统个股取用神法。开/生门 +2、休门 +1、景/杜门 0、伤/惊门 -1、死门 -2，按分数正负分组。星、神、干仅展示，不追加分数。',
    accuracyNote:'当前盘为即时生成、未留存的观察结果，无已结算预测正确率；不回填历史、不混入上方梅花卦象统计。',
    sources:[{title:'排盘引擎与流派说明 · qimen-dunjia',url:'https://github.com/arc119226/qimen_dunjia'}]};
}
