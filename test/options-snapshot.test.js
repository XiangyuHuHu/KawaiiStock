import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = await mkdtemp(join(tmpdir(), 'options-snapshot-test-'));
process.env.OBSIDIAN_OPTIONS = dir;
const { rememberScan, saveOptionsScan, loadOptionsFile } = await import('../src/options/engine.js');
const { loadForward } = await import('../src/options/forward.js');
test('save uses server-held immutable scan; concurrent retry does not rescan or duplicate forward entries', async () => {
  const scanId='22222222-2222-2222-2222-222222222222';
  const pack={ok:true,scanId,date:'2026-09-15',generatedAt:'2026-09-15T15:00:00Z',modelVersion:'option-research-v3',strategy:{id:'cov'},ideas:[],buys:[],tempting:[],skipped:[],marker:'reviewed'};
  rememberScan(pack); pack.marker='mutated-after-review';
  const [a,b]=await Promise.all([saveOptionsScan(scanId),saveOptionsScan(scanId)]);
  assert.equal(a.ok,true);assert.deepEqual(a,b);
  const saved=JSON.parse(await readFile(join(dir,'snapshots',`${scanId}.json`),'utf8'));
  assert.equal(saved.marker,'reviewed');
  assert.equal((await readdir(join(dir,'forward-quotes'))).length,1);
  assert.equal((await saveOptionsScan('unknown')).ok,false);
});
test('reading cached options and forward summary does not mutate files or trigger score collection', async () => {
  const scorePath=join(dir,'准确率.json');
  const original=JSON.stringify({ok:true,pending:[{symbol:'ABC'}],updatedAt:'old'});
  await writeFile(scorePath,original,'utf8');
  const names=await readdir(dir);
  const pack=await loadOptionsFile('2026-09-15');
  assert.equal(pack.score.updatedAt,'old');
  await loadForward();
  assert.equal(await readFile(scorePath,'utf8'),original);
  assert.deepEqual(await readdir(dir),names);
});

test('same-day replacement archives legacy and each new scan; history preserves original recommendations', async () => {
  const { writeOptions }=await import('../src/options/engine.js');
  const { listOptionsHistory, loadOptionsHistory }=await import('../src/options/history.js');
  const legacy={ok:true,date:'2026-09-10',generatedAt:'2026-09-10T15:00:00Z',strategy:{id:'cov'},ideas:[{symbol:'HIST',action:'BUY_CALL',contract:{type:'call',strike:100,expiration:'2026-09-25',bid:4,ask:5}}],buys:[{symbol:'HIST',action:'BUY_CALL',contract:{type:'call',strike:100,expiration:'2026-09-25',bid:4,ask:5}}]};
  await writeFile(join(dir,'2026-09-10-cov.json'),JSON.stringify(legacy),'utf8');
  for (const [id,hour] of [['33333333-3333-3333-3333-333333333333','16'],['44444444-4444-4444-4444-444444444444','17']]) {
    await writeOptions({ok:true,date:legacy.date,generatedAt:`2026-09-10T${hour}:00:00Z`,scanId:id,modelVersion:'option-research-v3',strategy:{id:'cov'},ideas:[],buys:[],tempting:[],skipped:[]});
  }
  const history=await listOptionsHistory();
  const sameDay=history.filter(r=>r.date===legacy.date);
  assert.equal(sameDay.length,3);
  const old=sameDay.find(r=>!r.scanId);
  assert.equal(old.originalBuyCount,1);
  const before=await readdir(dir);
  const viewed=await loadOptionsHistory(old.key);
  assert.equal(viewed.historicalView,true);assert.equal(viewed.buys.length,0);
  assert.equal(viewed.historicalBuys[0].action,'BUY_CALL');assert.equal(viewed.historicalBuys[0].contract.ask,5);
  assert.equal(viewed.ideas[0].eligible,false);
  assert.deepEqual(await readdir(dir),before);
  assert.equal(await loadOptionsHistory('snapshot:../../准确率'),null);
  assert.equal((await listOptionsHistory('other')).length,0);
});

test('immutable snapshot refuses conflicting content under the same scan ID', async () => {
  const { archiveOptions }=await import('../src/options/history.js');
  const a={scanId:'55555555-5555-5555-5555-555555555555',date:'2026-09-15',marker:'original'};
  await archiveOptions(a); await archiveOptions(a);
  await assert.rejects(archiveOptions({...a,marker:'modified'}),/拒绝覆盖/);
  const stored=JSON.parse(await readFile(join(dir,'snapshots',`${a.scanId}.json`),'utf8'));
  assert.equal(stored.marker,'original');
});
