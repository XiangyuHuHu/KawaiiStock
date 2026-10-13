import test from 'node:test';
import assert from 'node:assert/strict';
import {castSymbol,interpret,relation,validOracleDay,buildSymbolOracle} from '../src/oracle/symbols.js';
import {buildOracleDesk,judgeReading,SPX_2026_09_16} from '../src/oracle/qimen.js';

test('daily casting is reproducible and independent of refresh time and realized prices',async()=>{
  assert.deepEqual(castSymbol('nvda','2026-09-21'),castSymbol('NVDA','2026-09-21'));
  assert.notEqual(castSymbol('NVDA','2026-09-21').seed,castSymbol('NVDA','2026-09-22').seed);
  const universeLoader=async()=>[{symbol:'NVDA',last:1},{symbol:'NVDA',last:999},{symbol:'MU'}];
  const a=await buildSymbolOracle({date:'2026-09-21',now:Date.parse('2026-09-21T12:00Z'),universeLoader});
  const b=await buildSymbolOracle({date:'2026-09-21',now:Date.parse('2026-09-21T20:00Z'),universeLoader});
  assert.deepEqual(a.rows,b.rows);assert.equal(a.rows.length,2);assert.equal(a.liveTrading,false);
  assert.equal(Object.values(a.counts).reduce((s,v)=>s+v,0),2);assert.equal(a.retrospective,false);
});
test('moving line and mutual trigrams use bottom-up order; conflict never becomes a bullish recommendation',()=>{
  for(let u=1;u<=8;u++)for(let l=1;l<=8;l++)for(let m=1;m<=6;m++){
    const r=interpret(u,l,m);
    assert.equal(r.original.lines.filter((v,i)=>v!==r.changed.lines[i]).length,1);
    assert.notEqual(r.original.lines[m-1],r.changed.lines[m-1]);
    assert.deepEqual(r.mutual.lines,[...r.original.lines.slice(1,4),...r.original.lines.slice(2,5)]);
    assert.equal(r.body.number,m<=3?u:l);
    if(r.start.value*r.end.value<0)assert.equal(r.direction,'neutral');
  }
  assert.equal(relation('木','水').label,'用生体');assert.equal(relation('木','金').label,'用克体');
  assert.equal(relation('木','火').label,'体生用');assert.equal(relation('木','土').label,'体克用');
});
test('invalid dates and traversal rejected; historical recomputation and non-session days labeled',async()=>{
  for(const date of ['../../data','2026-02-30','2026-13-01']) {assert.equal(validOracleDay(date),false);assert.throws(()=>castSymbol('ABC',date));}
  const p=await buildSymbolOracle({date:'2026-09-20',now:Date.parse('2026-09-21T15:00Z'),universeLoader:async()=>[]});
  assert.equal(p.retrospective,true);assert.equal(p.sessionDay,false);assert.deepEqual(p.counts,{up:0,down:0,neutral:0});
  await assert.rejects(buildOracleDesk({date:'../../data'}),/观察日无效/);
});
test('manual refresh bypasses chart cache and old readings never borrow current price',async()=>{
  let options;
  const p=await buildOracleDesk({date:'2026-09-16',refresh:true,loader:async(s,o)=>{options=o;return {ok:true,bars:[],last:999,quoteAt:Date.parse('2026-09-21T15:00Z')};}});
  assert.equal(options.refresh,true);assert.equal(p.session.last,null);assert.equal(p.session.quoteAt,null);
  const ts=Date.parse('2026-09-16T14:00Z');
  const pending=judgeReading(SPX_2026_09_16,{now:ts+1000,bars:[{ts,open:100,close:110,high:110,low:100}]});
  assert.equal(pending.path.length,0);assert.equal(pending.session.last,null);
});
