import { deskById, loadConfig, loadHoldings, loadStrategy } from './holdings.js';

function indexPositions(book) {
  return new Map((book?.positions || []).map((row) => [String(row.symbol || '').toUpperCase(), row]));
}

function qtyOf(row) {
  if (row?.qty == null || row.qty === '') return null;
  const n = Number(row.qty);
  return Number.isFinite(n) ? n : null;
}

function diffBooks(grokBook, chatgptBook) {
  const grokMap = indexPositions(grokBook);
  const gptMap = indexPositions(chatgptBook);
  const symbols = [...new Set([...grokMap.keys(), ...gptMap.keys()])].filter(Boolean).sort();
  const both = [];
  const grokOnly = [];
  const chatgptOnly = [];
  for (const symbol of symbols) {
    const grok = grokMap.get(symbol);
    const chatgpt = gptMap.get(symbol);
    if (grok && chatgpt) {
      const gq = qtyOf(grok);
      const cq = qtyOf(chatgpt);
      both.push({
        symbol,
        grokName: grok.name || '',
        chatgptName: chatgpt.name || '',
        grokQty: gq,
        chatgptQty: cq,
        grokRole: grok.role || '',
        chatgptRole: chatgpt.role || '',
        qtyMatch: gq != null && cq != null ? gq === cq : gq === cq
      });
    } else if (grok) {
      grokOnly.push({ symbol, name: grok.name || '', qty: qtyOf(grok), role: grok.role || '' });
    } else {
      chatgptOnly.push({ symbol, name: chatgpt.name || '', qty: qtyOf(chatgpt), role: chatgpt.role || '' });
    }
  }
  return {
    both,
    grokOnly,
    chatgptOnly,
    stats: {
      grokCount: grokBook?.positions?.length ?? 0,
      chatgptCount: chatgptBook?.positions?.length ?? 0,
      bothCount: both.length,
      qtyMismatch: both.filter((row) => !row.qtyMatch).length,
      grokOnlyCount: grokOnly.length,
      chatgptOnlyCount: chatgptOnly.length
    }
  };
}

function blurb(strategy) {
  const body = strategy?.body || '';
  const quote = body.match(/^> (.+)$/m);
  if (quote) return quote[1].replace(/\*\*/g, '').slice(0, 180);
  const para = body.split('\n').find((line) => line.trim() && !line.startsWith('#'));
  return (para || '').slice(0, 180);
}

export async function buildCompare() {
  const config = await loadConfig();
  const grokDesk = deskById(config, 'grok');
  const chatgptDesk = deskById(config, 'chatgpt');
  const accounts = [];

  for (const spec of config.compare.accounts) {
    const grokAccount = grokDesk.accounts.find((row) => row.id === spec.id);
    const chatgptAccount = chatgptDesk.accounts.find((row) => row.id === spec.id);
    const [grokHoldings, chatgptHoldings, grokStrategy, chatgptStrategy] = await Promise.all([
      loadHoldings(grokAccount),
      loadHoldings(chatgptAccount),
      loadStrategy(grokAccount, grokDesk),
      loadStrategy(chatgptAccount, chatgptDesk)
    ]);
    const overlap = diffBooks(grokHoldings, chatgptHoldings);
    accounts.push({
      id: spec.id,
      label: spec.label,
      rows: spec.rows,
      overlap,
      grok: {
        account: grokAccount,
        holdings: grokHoldings,
        strategyError: grokStrategy.error,
        blurb: blurb(grokStrategy)
      },
      chatgpt: {
        account: chatgptAccount,
        holdings: chatgptHoldings,
        strategyError: chatgptStrategy.error,
        blurb: blurb(chatgptStrategy)
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    desks: config.desks.map((desk) => ({
      id: desk.id,
      label: desk.label,
      kicker: desk.kicker,
      subtitle: desk.subtitle,
      writable: desk.writable
    })),
    accounts
  };
}
