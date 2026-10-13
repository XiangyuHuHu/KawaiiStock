import { loadQuotes } from './quotes.js';
import { loadDailyReports, loadRecFiles } from './reports.js';
import { accountById, deskById, loadAccounts, loadHoldings, loadStrategy } from './holdings.js';
import { loadUniverse } from './universe.js';
import { loadWatchScore } from './strategy/watch-score.js';
import { recommendationStatus, dailyOutputLocations } from './desk-updates.js';

export async function loadConfig() {
  return loadAccounts();
}

export async function buildDesk(accountId = 'main', deskId = 'grok') {
  const config = await loadAccounts(deskId);
  const desk = config.desk || deskById(config, deskId);
  const account = accountById(config, accountId) || desk.accounts[0];
  const [universe, reports, recs, strategy, holdings, watchScore] = await Promise.all([
    loadUniverse(),
    loadDailyReports(),
    loadRecFiles(deskId),
    loadStrategy(account, desk),
    loadHoldings(account),
    loadWatchScore()
  ]);
  const latestRec = recs[0] ?? null;
  const accountRec = latestRec?.json?.accounts?.find((row) => row.id === account.id) ?? null;
  const updates = deskId === 'chatgpt' ? {
    ...recommendationStatus({account,holdings,recs}), outputs: await dailyOutputLocations(deskId)
  } : null;

  return {
    generatedAt: new Date().toISOString(),
    config: {
      ...config,
      desks: config.desks.map((row) => ({
        id: row.id,
        label: row.label,
        kicker: row.kicker,
        subtitle: row.subtitle,
        writable: row.writable
      }))
    },
    desk: {
      id: desk.id,
      label: desk.label,
      kicker: desk.kicker,
      subtitle: desk.subtitle,
      writable: desk.writable,
      vault: desk.vault
    },
    account,
    holdings,
    strategy: { path: strategy.path, meta: strategy.meta, error: strategy.error, html: strategy.html },
    universe: {
      error: universe.error,
      lists: universe.lists.map(({ file, title, bucket, count }) => ({ file, title, bucket, count })),
      symbolCount: universe.symbols.length
    },
    reports: desk.id === 'grok'
      ? reports.map((row) => ({ date: row.date, stance: row.stance, headline: row.headline, source: row.source }))
      : [],
    recs: recs.map((row) => ({ date: row.date, html: row.html, json: row.json, files: row.files, error: row.error })),
    latestRec,
    accountRec,
    updates,
    watchScore
  };
}

export async function buildTape(desk) {
  const symbols = [
    ...(desk.config.focusTape ?? []),
    ...(desk.holdings?.positions ?? []).map((row) => row.symbol)
  ].filter(Boolean);
  return { quotes: await loadQuotes([...new Set(symbols)].slice(0, 24)) };
}

export async function buildUniversePage() {
  const [config, universe] = await Promise.all([loadAccounts(), loadUniverse()]);
  const quotes = await loadQuotes(universe.symbols.map((row) => row.symbol).slice(0, 36));
  return {
    generatedAt: new Date().toISOString(),
    config,
    error: universe.error,
    lists: universe.lists,
    rows: universe.symbols.map((row) => ({ ...row, quote: quotes[row.symbol] ?? null }))
  };
}
