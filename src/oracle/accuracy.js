import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { OBSIDIAN_ORACLE } from '../paths.js';
import { loadHistoricals } from '../historicals.js';
import { mapPool } from '../options/market.js';
import { validOracleDay } from './symbols.js';
import { oracleMarket } from './markets.js';
import { loadChinaOracleHistory } from './cn-data.js';

export const RULE = 'premarket-open-close-v1';
const round = n => Math.round(n * 100) / 100;
const matchingLocked = (r, p, row) => {
  if(!r || (r.market||'us')!==(p.market||'us') || r.status!=='locked' || r.date!==p.date || r.symbol!==row.symbol || r.direction!==row.direction || r.recordedAt!==p.recordedAt || !r.source || ![r.open,r.close].every(n=>Number.isFinite(n)&&n>0))return false;
  const delta=r.close-r.open, actual=delta>0?'up':delta<0?'down':'flat';
  if(p.market==='cn'&&!(Number.isFinite(r.volume)&&r.volume>0))return false;
  return r.actual===actual && r.hit===(row.direction==='up'?delta>0:delta<0) && r.changePct===round(delta/r.open*100);
};

export function gradeOracle(snapshot, row, history, now = Date.now()) {
  const config=oracleMarket(snapshot.market||'us');
  const base = { market:config.id,date: snapshot.date, symbol: row.symbol, direction: row.direction, recordedAt: snapshot.recordedAt, hit: null, changePct: null };
  const recordedAt = Date.parse(snapshot.recordedAt);
  if (snapshot.method !== config.method || snapshot.rule !== RULE || !validOracleDay(snapshot.date) || !config.supported(snapshot.date) || !Number.isFinite(recordedAt) || recordedAt > now || recordedAt >= config.cutoff(snapshot.date)) return { ...base, status: 'excluded', reason: '缺少有效盘前留存，或方法/结算版本不匹配' };
  if (row.direction === 'neutral') return { ...base, status: 'neutral', reason: '观望不参与方向正确率' };
  if (!['up', 'down'].includes(row.direction)) return { ...base, status: 'excluded', reason: '方向无效' };
  if (now < config.close(snapshot.date) + 900000) return { ...base, status: 'pending', reason: '等待本日收盘及 15 分钟行情缓冲' };
  const bars = history?.bars?.filter(b => b.date === snapshot.date) || [];
  const b = bars[0];
  if(config.id==='cn' && !(Number.isFinite(b?.volume)&&b.volume>0))return {...base,status:'missing',reason:'停牌、无成交或缺有效成交量，不计为平盘命中/失败'};
  if (!history?.ok || !history.source || bars.length !== 1 || ![b?.open, b?.close, b?.high, b?.low].every(n => Number.isFinite(n) && n > 0) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) return { ...base, status: 'missing', reason: '缺少该交易日完整且有效的日线；不借用其他日期，后续刷新重试' };
  const delta = b.close - b.open;
  return { ...base, status: 'locked', open: b.open, close: b.close, volume:b.volume, source: history.source,
    settledAt: new Date(now).toISOString(), changePct: round(delta / b.open * 100), actual: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    hit: row.direction === 'up' ? delta > 0 : delta < 0, reason: delta === 0 ? '开收盘持平，方向预测未命中' : '同日开盘至收盘方向对照；不是收益率回测' };
}

export function summarizeOracle(records) {
  const tally = rows => {
    const locked = rows.filter(r => r.status === 'locked');
    const n = locked.length, hits = locked.filter(r => r.hit === true).length;
    // Wilson interval is descriptive: same-day symbols are not independent trials.
    const p = n ? hits / n : 0, z = 1.96, denom = 1 + z * z / (n || 1);
    const center = (p + z * z / (2 * (n || 1))) / denom;
    const half = z * Math.sqrt(p * (1 - p) / (n || 1) + z * z / (4 * (n || 1) ** 2)) / denom;
    return { n, hits, rate: n ? round(hits / n * 100) : null, interval95: n ? [round((center - half) * 100), round((center + half) * 100)] : null,
      days: new Set(locked.map(r => r.date)).size };
  };
  const scored = records.filter(r => r.status === 'locked');
  return { all: tally(records), up: tally(records.filter(r => r.direction === 'up')), down: tally(records.filter(r => r.direction === 'down')),
    pending: records.filter(r => r.status === 'pending').length, missing: records.filter(r => r.status === 'missing').length,
    neutral: records.filter(r => r.status === 'neutral').length, excluded: records.filter(r => r.status === 'excluded').length,
    baseline: scored.length ? { up: round(scored.filter(r => r.actual === 'up').length / scored.length * 100), down: round(scored.filter(r => r.actual === 'down').length / scored.length * 100) } : null };
}

export function createOracleAccuracy({ market='us',dir, now = Date.now, loader } = {}) {
  const config=oracleMarket(market),prefix=`${config.method}--${RULE}--`;
  dir ||= join(OBSIDIAN_ORACLE, market==='cn'?'direction-accuracy-cn':'direction-accuracy');
  loader ||= market==='cn'?loadChinaOracleHistory:loadHistoricals;
  let queue = Promise.resolve();
  const serialized = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  async function files() { try { return await readdir(dir); } catch (e) { if(e.code === 'ENOENT')return [];throw e; } }
  async function loadSnapshots() {
    const snapshots = [], errors = [];
    for (const name of (await files()).filter(n => n.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.json$/.test(n.slice(prefix.length)))) {
      try {
        const p = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if((p.market||'us')!==market || p.date !== name.slice(prefix.length,-5) || !Array.isArray(p.rows) || p.rows.some(r=>!r || !config.validSymbol(r.symbol)) || new Set(p.rows.map(r=>r.symbol)).size!==p.rows.length) throw Error('bad snapshot');
        snapshots.push(p);
      } catch { errors.push(`无法读取留存文件 ${name}，原文件保留，统计可能不完整`); }
    }
    return { snapshots, errors };
  }
  async function results() {
    try { return JSON.parse(await readFile(join(dir, `${prefix}results.json`), 'utf8')); }
    catch(e) { if(e.code === 'ENOENT')return {updatedAt:null,records:[]};throw Error('结算文件损坏，停止更新并保留原文件'); }
  }
  async function read({ date = config.today(new Date(now())) } = {}) {
    const {snapshots,errors}=await loadSnapshots();
    const result=await results();
    if(!Array.isArray(result.records))throw Error('结算文件格式无效');
    const records = snapshots.flatMap(p=>p.rows.map(row=>{
      const basic=gradeOracle(p,row,null,now());
      if(['excluded','neutral','pending'].includes(basic.status))return basic;
      return result.records.find(r=>matchingLocked(r,p,row)) || basic;
    }));
    const snapshot=snapshots.find(p=>p.date===date);
    const today=config.today(new Date(now()));
    const nextTrackableDate=config.supported(today)&&now()<config.cutoff(today)?today:config.next(today);
    return {ok:true,liveTrading:false,market,marketLabel:config.label,timeZone:config.timeZone,timeLabel:config.timeLabel,cutoffLabel:config.cutoffLabel,closeLabel:config.closeLabel,method:config.method,rule:RULE,updatedAt:result.updatedAt,summary:summarizeOracle(records),
      selected: {date:date||null,recordedAt:snapshot?.recordedAt||null,count:snapshot?.rows.length||0},nextTrackableDate,
      records:records.sort((a,b)=>b.date.localeCompare(a.date)||a.symbol.localeCompare(b.symbol)),errors,
      note:'累计仅统计本方法版本、开盘前首次留存的名单。固定同日开盘 → 收盘；收盘后 15 分钟起可结算。平盘算未命中，观望/待结算/缺行情不计入正确率分母。手动刷新留存与结算；打开页面只展示统计。正确率不是盈利率，同日标的相关，区间仅作描述。'};
  }
  async function refresh(pack) {
    return serialized(async()=>{
      let capture;
      const clock=now();
      if((pack.market||'us')!==market)throw Error('不能跨市场留存或结算');
      if(pack.method!==config.method || !validOracleDay(pack.date) || !config.supported(pack.date) || clock >= config.cutoff(pack.date)) capture='本日不符合盘前留存条件（非交易日、日历不支持或已开盘），不新增预测样本';
      else if(!pack.rows?.length)capture='观察池为空，未创建留存';
      else {
        await mkdir(dir,{recursive:true});
        const path=join(dir,`${prefix}${pack.date}.json`);
        const snapshot={market,date:pack.date,method:config.method,rule:RULE,recordedAt:new Date(clock).toISOString(),rows:pack.rows.map(r=>({symbol:r.symbol,direction:r.direction,seed:r.seed}))};
        try { await writeFile(path,JSON.stringify(snapshot,null,2),{encoding:'utf8',flag:'wx'});capture='已留存首次盘前名单；同日刷新不会覆盖或追加样本'; }
        catch(e) { if(e.code!=='EEXIST')throw e;capture='已存在本日首次留存，保留原名单和记录时间'; }
      }
      const {snapshots}=await loadSnapshots(), previous=await results();
      if(!Array.isArray(previous.records))throw Error('结算文件格式无效');
      const stored=new Map(previous.records.map(r=>[`${r.date}:${r.symbol}`,r]));
      const due=snapshots.flatMap(p=>p.rows.map(row=>({p,row,basic:gradeOracle(p,row,null,clock)})))
        .filter(({p,row,basic})=>basic.status==='missing'&&!matchingLocked(stored.get(`${p.date}:${row.symbol}`),p,row));
      const histories=new Map();
      await mapPool([...new Set(due.map(x=>x.row.symbol))],async symbol=>{try{histories.set(symbol,await loader(symbol,{refresh:true}));}catch{histories.set(symbol,null);}},{concurrency:3});
      for(const {p,row} of due)stored.set(`${p.date}:${row.symbol}`,gradeOracle(p,row,histories.get(row.symbol),now()));
      const records=[...stored.values()];
      if(due.length) {
        await mkdir(dir,{recursive:true});
        const path=join(dir,`${prefix}results.json`);
        await writeFile(`${path}.tmp`,JSON.stringify({updatedAt:new Date(now()).toISOString(),records},null,2),'utf8');
        await rename(`${path}.tmp`,path);
      }
      return {...await read({date:pack.date}),capture};
    });
  }
  return {read,refresh};
}
export const oracleAccuracy = createOracleAccuracy();
export const chinaOracleAccuracy = createOracleAccuracy({market:'cn'});
