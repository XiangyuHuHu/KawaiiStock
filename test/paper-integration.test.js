import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('isolated paper ledger: duplicate, conflict, IOC rejection and add/trim accounting', async () => {
  // Child has its own directories and mocked transport; never touches the user's ledgers.
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-test-'));
  const script = `
    import assert from 'node:assert/strict';
    import { placePaperOrder, loadPaperLedger } from './src/paper/desk.js';
    const now = Date.parse('2026-09-10T15:00:00Z');
    Date.now = () => now;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { lastSalePrice: '$100', previousClose: '$99', chart: [{ x: now, y: 100 }] } }) });
    const order = { id: 'test-one', desk: '0b', symbol: 'TEST', side: 'buy', instrument: 'equity', qty: 10, limitPrice: 101, stopPrice: 90, maxLoss: null };
    const first = await placePaperOrder(order);
    assert.equal(first.ok, true, JSON.stringify(first.decision));
    const replay = await placePaperOrder(order);
    assert.equal(replay.replay, true);
    assert.equal((await loadPaperLedger('0b')).fills.length, 1);
    const conflict = await placePaperOrder({ ...order, qty: 20 });
    assert.equal(conflict.decision.code, 'id-conflict');
    const low = await placePaperOrder({ ...order, id: 'too-low', limitPrice: 1 });
    assert.equal(low.decision.code, 'limit-not-marketable');
    const add = await placePaperOrder({ ...order, id: 'test-two', qty: 5 });
    assert.equal(add.ok, true, JSON.stringify(add.decision));
    assert.ok(Math.abs(add.ledger.positions[0].maxLoss - 150.75) < .0001);
    const trim = await placePaperOrder({ ...order, id: 'test-three', side: 'sell', qty: 5, limitPrice: 99, reduceOnly: true });
    assert.equal(trim.ok, true, JSON.stringify(trim.decision));
    const ledger = await loadPaperLedger('0b');
    assert.equal(ledger.fills.length, 3);
    assert.equal(ledger.positions[0].qty, 10);
    assert.ok(Math.abs(ledger.cash - (50000 - 15 * 100.05 + 5 * 99.95)) < .0001);
    assert.ok(Math.abs(ledger.positions[0].maxLoss - 100.5) < .0001);
    const parallel = await Promise.all([placePaperOrder({ ...order, id: 'concurrent' }), placePaperOrder({ ...order, id: 'concurrent' })]);
    assert.equal(parallel.filter((r) => r.ok).length, 1);
    assert.equal((await loadPaperLedger('0b')).fills.filter((f) => f.id === 'concurrent').length, 1);
    console.log('integration-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, KAWAII_DATA_DIR: join(dir, 'data'), OBSIDIAN_PAPER: join(dir, 'paper') }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /integration-ok/);
});

test('oracle paper support excludes a previous session and mismatched file dates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-support-'));
  const script = `
    import assert from 'node:assert/strict';
    import {mkdir,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {loadOracleSupport} from './src/paper/auto.js';
    const day='2026-09-28';
    for(const path of [process.env.OBSIDIAN_WATCH,process.env.OBSIDIAN_RECS,process.env.KAWAII_REPORTS_DIR])await mkdir(path,{recursive:true});
    const watch={date:'2026-09-27',boards:{confirmed:[{symbol:'MU',allowNewLong:true}]}};
    const rec={date:'2026-09-27',accounts:[{recommendations:[{symbol:'NVDA',action:'BUY'}]}]};
    await writeFile(join(process.env.OBSIDIAN_WATCH,day+'.json'),JSON.stringify(watch));
    await writeFile(join(process.env.OBSIDIAN_RECS,day+'.json'),JSON.stringify(rec));
    let result=await loadOracleSupport(day);
    assert.equal(result.confirmed.size,0);assert.equal(result.buys.size,0);
    await writeFile(join(process.env.KAWAII_REPORTS_DIR,day+'-每日观察.json'),JSON.stringify({...watch,date:day}));
    result=await loadOracleSupport(day);
    assert.deepEqual([...result.confirmed],['MU']);assert.equal(result.buys.size,0);
    await writeFile(join(process.env.OBSIDIAN_WATCH,day+'.json'),JSON.stringify({...watch,date:day}));
    await writeFile(join(process.env.OBSIDIAN_RECS,day+'.json'),JSON.stringify({...rec,date:day}));
    result=await loadOracleSupport(day);
    assert.deepEqual([...result.confirmed],['MU']);assert.deepEqual([...result.buys],['NVDA']);
    console.log('support-date-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_WATCH: join(dir, 'watch'), OBSIDIAN_RECS: join(dir, 'recs'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /support-date-ok/);
});

test('option paper view keeps calls and puts distinct and marks old premium as stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-options-'));
  const script = `
    import assert from 'node:assert/strict';
    import {loadPaperLedger,savePaperLedger,getPaperView,setPaperOptionChainLoader} from './src/paper/desk.js';
    setPaperOptionChainLoader(async () => ({ ok: false, calls: [], puts: [], expirationDates: [] }));
    const book=await loadPaperLedger('0e');
    book.cash=99790;
    book.positions=['call','put'].map((optionType)=>({symbol:'MU',instrument:'option',qty:1,avgCost:1.05,last:1.05,marketValue:105,expiration:'2026-10-09',strike:120,optionType}));
    book.lastAuto={date:'2026-09-28',reviews:[
      {symbol:'MU',expiration:'2026-10-09',strike:120,optionType:'call',action:'HOLD',label:'看涨留仓'},
      {symbol:'MU',expiration:'2026-10-09',strike:120,optionType:'put',action:'REVIEW',label:'看跌缺价'}
    ]};
    await savePaperLedger(book);
    const view=await getPaperView('0e');
    assert.equal(view.ledger.valuationFresh,false);
    assert.equal(view.book.stale,true);
    assert.equal(view.exits.length,2);
    assert.deepEqual(view.exits.map(row=>row.action),['HOLD','REVIEW']);
    console.log('option-paper-view-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_RECS: join(dir, 'recs'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /option-paper-view-ok/);
});

test('paper view marks an option at the bid/ask mid and ignores the stock price', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-option-mark-'));
  const script = `
    import assert from 'node:assert/strict';
    import {loadPaperLedger,savePaperLedger,getPaperView,setPaperOptionChainLoader} from './src/paper/desk.js';
    setPaperOptionChainLoader(async (symbol, expirationUnix) => ({
      ok: true, symbol, last: 999, expirationDates: [expirationUnix],
      calls: [{ symbol, type: 'call', expiration: '2026-10-09', strike: 205, bid: 5.4, ask: 6.4 }],
      puts: [{ symbol, type: 'put', expiration: '2026-10-09', strike: 205, bid: 1, ask: 1.2 }]
    }));
    const book = await loadPaperLedger('0e');
    book.cash = 90000;
    book.positions = [
      { symbol: 'ANET', instrument: 'option', qty: 1, avgCost: 8.05, last: 8.05, marketValue: 805, expiration: '2026-10-09', strike: 205, optionType: 'call' },
      { symbol: 'NOPE', instrument: 'option', qty: 1, avgCost: 2, last: 2, marketValue: 200, expiration: '2026-10-09', strike: 10, optionType: 'call' }
    ];
    await savePaperLedger(book);
    const view = await getPaperView('0e');
    const anet = view.ledger.positions.find((row) => row.symbol === 'ANET');
    const nope = view.ledger.positions.find((row) => row.symbol === 'NOPE');
    assert.equal(anet.last, 5.9);
    assert.equal(anet.marketValue, 590);
    assert.ok(anet.markedAt);
    assert.equal(nope.last, 2);
    assert.equal(view.ledger.valuationFresh, false);
    const saved = await loadPaperLedger('0e');
    assert.equal(saved.positions[0].last, 8.05);
    console.log('option-mark-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_RECS: join(dir, 'recs'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /option-mark-ok/);
});

test('paper view uses the option last trade when the bid and ask are zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-option-last-'));
  const tradedAt = Date.parse('2026-10-02T20:00:19Z');
  const script = `
    import assert from 'node:assert/strict';
    import {loadPaperLedger,savePaperLedger,getPaperView,setPaperOptionChainLoader} from './src/paper/desk.js';
    const tradedAt = ${tradedAt};
    setPaperOptionChainLoader(async (symbol) => ({
      ok: true, symbol, last: 200,
      calls: [{ symbol, type: 'call', expiration: '2026-10-09', strike: 205, bid: 0, ask: 0, last: 6.13, lastTradeAt: tradedAt }],
      puts: []
    }));
    const book = await loadPaperLedger('0e');
    book.positions = [{ symbol: 'ANET', instrument: 'option', qty: 1, avgCost: 8.05, last: 8.05, marketValue: 805, expiration: '2026-10-09', strike: 205, optionType: 'call' }];
    await savePaperLedger(book);
    const view = await getPaperView('0e');
    const anet = view.ledger.positions[0];
    assert.equal(anet.last, 6.13);
    assert.equal(anet.marketValue, 613);
    assert.equal(anet.markKind, 'last');
    assert.equal(anet.markedAt, new Date(tradedAt).toISOString());
    assert.equal(view.ledger.valuationFresh, false);
    console.log('option-last-mark-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_RECS: join(dir, 'recs'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /option-last-mark-ok/);
});

test('paper option API ignores a caller-supplied fresh quote without a saved same-day scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-quote-'));
  const script = `
    import assert from 'node:assert/strict';
    import {placePaperOrder,loadPaperLedger} from './src/paper/desk.js';
    const now=Date.parse('2026-09-28T15:00:00Z');Date.now=()=>now;
    const result=await placePaperOrder({desk:'0e',instrument:'option',symbol:'MU',side:'buy',
      optionType:'call',expiration:'2026-10-09',strike:120,qty:1,limitPrice:2,
      bid:1,ask:1.1,quoteAt:now-1000,stopPrice:0.5,maxLoss:110});
    assert.equal(result.ok,false);
    assert.equal(result.decision.code,'contract-quote-required');
    assert.equal((await loadPaperLedger('0e')).fills.length,0);
    console.log('untrusted-option-quote-rejected');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_OPTIONS: join(dir, 'options'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /untrusted-option-quote-rejected/);
});

test('paper option reduce sells the held expiration from the chain, not the caller price', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawaii-paper-option-exit-'));
  const script = `
    import assert from 'node:assert/strict';
    import { placePaperOrder, loadPaperLedger, savePaperLedger, setPaperOptionChainLoader } from './src/paper/desk.js';
    const now = Date.parse('2026-10-09T15:00:00Z');
    Date.now = () => now;
    setPaperOptionChainLoader(async () => ({
      ok: true,
      calls: [{ type: 'call', expiration: '2026-10-09', strike: 205, bid: 1.2, ask: 1.4, quoteAt: null, standard: true, multiplier: 100 }],
      puts: []
    }));
    const book = await loadPaperLedger('0e');
    book.positions = [{ symbol: 'ANET', instrument: 'option', qty: 1, avgCost: 8.05, last: 8.05, marketValue: 805, expiration: '2026-10-09', strike: 205, optionType: 'call', stopPrice: 6.4, maxLoss: 805 }];
    await savePaperLedger(book);
    const result = await placePaperOrder({
      desk: '0e', instrument: 'option', symbol: 'ANET', side: 'sell', reduceOnly: true,
      optionType: 'call', expiration: '2026-10-09', strike: 205, qty: 1,
      limitPrice: 1.2 * 0.998, bid: 99, ask: 99, quoteAt: now, stopPrice: 6.4, maxLoss: 805,
      structure: 'long', type: 'limit'
    });
    assert.equal(result.ok, true, JSON.stringify(result.decision));
    assert.ok(result.fill.price < 2, String(result.fill.price));
    assert.equal((await loadPaperLedger('0e')).positions.length, 0);
    console.log('held-option-exit-ok');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      ...process.env,
      KAWAII_DATA_DIR: join(dir, 'data'), KAWAII_REPORTS_DIR: join(dir, 'reports'),
      OBSIDIAN_OPTIONS: join(dir, 'options'), OBSIDIAN_PAPER: join(dir, 'paper')
    }
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /held-option-exit-ok/);
});
