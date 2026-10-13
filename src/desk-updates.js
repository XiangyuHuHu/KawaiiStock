import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { asOfStamp, lastSessionStamp, recsDir, simVaultDir, actualsDir, OBSIDIAN_HOLDINGS } from './paths.js';

export function recommendationStatus({account,holdings,recs,observationDate=lastSessionStamp()}) {
  const latest=recs[0] || null;
  const book=latest?.json?.accounts?.find(r=>r.id===account.id);
  const rows=book?.recommendations || [];
  const unavailable=['unavailable','blocked','error'].includes(book?.status);
  const status=latest?.error?'invalid':!latest?'missing-file':!book?'missing-account':unavailable?'unavailable':rows.length?'available':'empty';
  const reason=latest?.error || book?.reason || ({'missing-file':'尚未找到推荐文件。','missing-account':'最新推荐文件没有本账户的结构化建议。',unavailable:'本账户缺少必要数据，未生成动作。',empty:'本账户没有逐股建议；这不等于空仓或全部 HOLD。',available:'已读取本账户逐股建议。'})[status];
  const previous=recs.find(r=>r!==latest&&!r.error&&r.json?.accounts?.some(a=>a.id===account.id&&a.recommendations?.length&&!['unavailable','blocked','error'].includes(a.status)));
  const holdingsDate=asOfStamp(holdings.dataAsOf || holdings.asOf);
  const warnings=[];
  if(!holdingsDate || holdingsDate<observationDate)warnings.push(`持仓快照${holdingsDate?`为 ${holdingsDate}，落后于观察日`:'缺少可靠日期'}`);
  if(!latest?.date || latest.date<observationDate)warnings.push(`推荐文件${latest?.date?`为 ${latest.date}，落后于观察日`:'缺失'}`);
  if(status!=='available')warnings.push(reason);
  if(book?.status==='snapshot_partial')warnings.push('本账户快照为部分数据，建议需要复核');
  const symbols=new Set(rows.map(r=>String(r.symbol||'').toUpperCase()));
  return {status,reason,observationDate,recommendationDate:latest?.date||null,holdingsDate,
    recommendationGeneratedAt:latest?.json?.generated_at||latest?.json?.generatedAt||latest?.meta?.generated_at||null,
    matched:unavailable?0:(holdings.positions||[]).filter(r=>symbols.has(String(r.symbol||'').toUpperCase())).length,
    positionCount:holdings.positions?.length||0,previousDate:previous?.date||null,warnings,
    files:{holdings:join(OBSIDIAN_HOLDINGS,account.holdingsFile||`${account.holdingsStem}.json`),recommendations:latest?.files||[]},
    accounts:(latest?.json?.accounts||[]).map(a=>({id:a.id,label:a.label||a.id,status:a.status||'recorded',count:a.recommendations?.length||0,reason:a.reason||null}))};
}

export async function latestArtifact(dir) {
  let files=[];
  try {files=(await readdir(dir)).filter(n=>/^\d{4}-\d{2}-\d{2}(?:[_.-].*)?\.(?:md|json)$/.test(n)).sort().reverse();} catch {}
  const date=files[0]?.slice(0,10)||null;
  return {directory:dir,date,files:files.filter(n=>n.startsWith(date||'!')).map(n=>join(dir,n))};
}

export async function dailyOutputLocations(advisor) {
  const [recommendations,simulation,actuals]=await Promise.all([
    latestArtifact(recsDir(advisor)),latestArtifact(simVaultDir(advisor)),latestArtifact(actualsDir(advisor))
  ]);
  return {recommendations,simulation,actuals};
}
