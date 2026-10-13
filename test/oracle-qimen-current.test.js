import test from 'node:test';
import assert from 'node:assert/strict';
import { currentQimenChart, buildCurrentQimen, qimenUniverse, qimenSymbol, qimenSectors } from '../src/oracle/qimen-current.js';

test('current chart uses explicit Beijing hour and a documented engine fixture',()=>{
  // Upstream README example: 2024-06-15 12:00, 芒种中元阳遁三局.
  const p=currentQimenChart(Date.parse('2024-06-15T04:37:00Z'));
  assert.equal(p.raw['陰陽'],'陽');assert.equal(p.raw['局數'],3);
  assert.equal(p.raw['三元'],'中元');assert.equal(p.key,'2024061512');
  assert.equal(p.effectiveAt,Date.parse('2024-06-15T04:00:00Z'));
  assert.equal(p.palaces.length,9);
  assert.equal(new Set(p.palaces.map(c=>c.num)).size,9);
  assert.equal(p.palaces.filter(c=>c.num!==5 && c.deity && c.heavenStem && c.earthStem).length,8);
});

test('same hour is stable while later hour recalculates the chart without random refresh',()=>{
  const a=currentQimenChart(Date.parse('2026-09-21T01:01Z'));
  const b=currentQimenChart(Date.parse('2026-09-21T01:59Z'));
  const c=currentQimenChart(Date.parse('2026-09-21T03:01Z'));
  assert.deepEqual(a,b);assert.notDeepEqual(a.palaces,c.palaces);
});

test('symbol mapping is stable, market-specific, excludes central palace and includes names',()=>{
  const p=currentQimenChart(Date.parse('2026-09-21T01:00Z'));
  for(let i=0;i<100;i++) {
    const r=qimenSymbol({market:'cn',symbol:String(i).padStart(6,'0'),name:'样本'},p.palaces);
    assert.notEqual(r.palaceId,'zhong');assert.equal(r.name,'样本');
    assert.deepEqual(r,qimenSymbol({market:'cn',symbol:String(i).padStart(6,'0'),name:'样本'},p.palaces));
    assert.equal(r.direction,r.score>0?'up':r.score<0?'down':'neutral');
  }
});

test('multi-market pool deduplicates and preserves A share leading zeros; failures are explicit',async()=>{
  const loaders={usLoader:async()=>[{symbol:'SPY'},{symbol:'NVDA'},{symbol:'NVDA'}],cnLoader:async()=>[{symbol:'002364',name:'中恒电气'}]};
  const all=await qimenUniverse('all',loaders);
  assert.equal(all.rows.filter(r=>r.symbol==='SPY').length,1);
  assert.ok(all.rows.some(r=>r.symbol==='002364' && r.name==='中恒电气'));
  const cn=await qimenUniverse('cn',loaders);assert.equal(cn.rows.length,1);
  const partial=await qimenUniverse('all',{...loaders,cnLoader:async()=>{throw Error('offline');}});
  assert.equal(partial.errors.length,1);assert.ok(partial.rows.some(r=>r.symbol==='GLD'));
  await assert.rejects(qimenUniverse('bad'),/范围无效/);
});

test('fresh generated chart has no fabricated history, quotes, phase scores or accuracy',async()=>{
  const now=Date.parse('2026-09-21T02:45Z');
  const p=await buildCurrentQimen({now,scope:'cn',universeLoader:async()=>({rows:[{symbol:'002364',market:'cn'}],errors:[]})});
  assert.equal(p.liveTrading,false);assert.equal(p.generatedAt,new Date(now).toISOString());
  assert.equal(p.effectiveAt,'2026-09-21T02:00:00.000Z');
  assert.equal(p.refreshAfter,'2026-09-21T03:00:00.000Z');
  assert.equal(p.rows.length,1);assert.equal(p.overall,undefined);assert.equal(p.path,undefined);
  assert.equal(p.rows[0].price,undefined);assert.match(p.accuracyNote,/未留存/);
  assert.deepEqual(p.sectors,[]);
});

test('sector board only counts symbols already on this chart',()=>{
  const rows=[
    { market:'us', symbol:'OKLO', name:'Oklo', palace:'乾六宫', men:'開門', direction:'up', score:2 },
    { market:'us', symbol:'SMR', name:'SMR', palace:'坎一宫', men:'死門', direction:'down', score:-2 },
    { market:'cn', symbol:'OKLO', name:'不应计入', palace:'离九宫', men:'生門', direction:'up', score:2 }
  ];
  const [power]=qimenSectors(rows);
  assert.equal(power.id,'power');
  assert.equal(power.up,1);
  assert.equal(power.down,1);
  assert.equal(power.lean,'neutral');
  assert.deepEqual(power.members.map(row=>row.symbol),['OKLO','SMR']);
  assert.equal(power.phases,undefined);
});
