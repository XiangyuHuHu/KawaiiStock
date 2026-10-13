import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommendationStatus,latestArtifact } from '../src/desk-updates.js';
import { loadRecFiles } from '../src/reports.js';

const account={id:'main',holdingsFile:'main.md'};
const holdings={asOf:'2026-08-21',positions:[{symbol:'MU',qty:103}]};
const current={date:'2026-09-22',json:{accounts:[{id:'main',status:'unavailable',reason:'未确认主账户映射',recommendations:[]},{id:'tactical',recommendations:[{symbol:'MU',action:'SELL'}]}]}};

test('unavailable main account does not borrow another account or turn into HOLD',()=>{
  const historical={date:'2026-09-08',json:{accounts:[{id:'main',recommendations:[{symbol:'MU',action:'HOLD'}]}]}};
  const u=recommendationStatus({account,holdings,recs:[current,historical],observationDate:'2026-09-22'});
  assert.equal(u.status,'unavailable');assert.equal(u.matched,0);assert.equal(u.previousDate,'2026-09-08');
  assert.equal(u.holdingsDate,'2026-08-21');assert.equal(u.recommendationDate,'2026-09-22');
  assert.equal(u.reason,'未确认主账户映射');assert.ok(u.warnings.some(x=>x.includes('2026-08-21')));
  assert.equal(current.json.accounts[0].recommendations.length,0);
});

test('missing, omitted and empty account remain distinct; partial snapshots disclose limitation',()=>{
  const args={account,holdings,observationDate:'2026-09-22'};
  assert.equal(recommendationStatus({...args,recs:[]}).status,'missing-file');
  assert.equal(recommendationStatus({...args,recs:[{date:'2026-09-22',json:{accounts:[]}}]}).status,'missing-account');
  assert.equal(recommendationStatus({...args,recs:[{date:'2026-09-22',json:{accounts:[{id:'main',recommendations:[]}]}}]}).status,'empty');
  const u=recommendationStatus({...args,recs:[{date:'2026-09-22',json:{accounts:[{id:'main',status:'snapshot_partial',recommendations:[{symbol:'MU',action:'REVIEW'}]}]}}]});
  assert.equal(u.matched,1);assert.ok(u.warnings.some(x=>x.includes('部分数据')));
});

test('JSON-only daily output is visible; corrupt or wrong-date newest output cannot silently fall back',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'desk-rec-'));
  try {
    await writeFile(join(dir,'2026-09-22.json'),'\uFEFF'+JSON.stringify({date:'2026-09-22',advisor:'chatgpt',accounts:[{id:'main',recommendations:[]}]}));
    let rows=await loadRecFiles('chatgpt',{dirs:[dir]});
    assert.equal(rows.length,1);assert.equal(rows[0].json.accounts[0].id,'main');
    await writeFile(join(dir,'2026-09-23.json'),'{bad json');
    rows=await loadRecFiles('chatgpt',{dirs:[dir]});
    assert.equal(rows[0].date,'2026-09-23');assert.equal(rows[0].json,null);assert.match(rows[0].error,/无法解析/);
    await writeFile(join(dir,'2026-09-23.json'),JSON.stringify({date:'2026-09-22',advisor:'chatgpt'}));
    rows=await loadRecFiles('chatgpt',{dirs:[dir]});assert.match(rows[0].error,/日期/);
    await writeFile(join(dir,'2026-09-23.json'),JSON.stringify({date:'2026-09-23',advisor:'grok'}));
    rows=await loadRecFiles('chatgpt',{dirs:[dir]});assert.match(rows[0].error,/顾问/);
    const u=recommendationStatus({account,holdings,recs:rows,observationDate:'2026-09-23'});
    assert.equal(u.status,'invalid');assert.equal(u.matched,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('task artifact discovery sees suffixed filenames but never substitutes modification date',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'desk-artifact-'));
  try {
    await writeFile(join(dir,'2026-09-21_三账户实际操作.md'),'old record');
    await writeFile(join(dir,'2026-09-22.json'),'{}');
    await writeFile(join(dir,'sim-chatgpt.json'),'{}');
    const out=await latestArtifact(dir);assert.equal(out.date,'2026-09-22');assert.equal(out.files.length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
