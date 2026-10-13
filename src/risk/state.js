import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR, todayStamp, weekStamp } from '../paths.js';
import { canRestore, worseMode } from './mode.js';
import { bookKeyOf } from './limits.js';
import { appendAudit } from './audit.js';

export const RISK_STATE_PATH = join(DATA_DIR, 'risk', 'state.json');

function emptyBook() {
  return {
    mode: 'NORMAL',
    reason: null,
    at: null,
    peakNav: null,
    pnlDay: 0,
    pnlWeek: 0,
    rejectCount: 0
  };
}

const EMPTY = {
  day: null,
  week: null,
  books: {
    live: emptyBook(),
    '0a': { ...emptyBook(), peakNav: 1_000_000 },
    '0b': { ...emptyBook(), peakNav: 50000 },
    '0c': { ...emptyBook(), peakNav: 5000 },
    '0d': { ...emptyBook(), peakNav: 100_000 },
    '0e': { ...emptyBook(), peakNav: 100_000 },
    '0f': { ...emptyBook(), peakNav: 100_000 },
    '0g': { ...emptyBook(), peakNav: 100_000 },
    '0h': { ...emptyBook(), peakNav: 100_000 }
  },
  seenOrderIds: {},
  lastCheck: null,
  kill: false,
  killReason: null,
  killAt: null
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function migrate(raw) {
  if (raw?.books) return raw;
  return {
    ...EMPTY,
    ...raw,
    books: {
      live: {
        ...emptyBook(),
        mode: raw?.kill ? 'KILL' : 'NORMAL',
        reason: raw?.killReason || null,
        at: raw?.killAt || null,
        peakNav: raw?.peakNavLive ?? null,
        pnlDay: raw?.realizedPnlToday || 0
      },
      '0a': { ...emptyBook(), peakNav: raw?.peakNavPaper ?? 1_000_000 },
      '0b': { ...emptyBook(), peakNav: 50000 },
      '0c': { ...emptyBook(), peakNav: 5000 }
    }
  };
}

export async function loadRiskState(date = todayStamp()) {
  const raw = migrate(await readJson(RISK_STATE_PATH) || {});
  const state = {
    ...EMPTY,
    ...raw,
    books: {
      live: { ...emptyBook(), ...(raw.books?.live || {}) },
      '0a': { ...emptyBook(), peakNav: 1_000_000, ...(raw.books?.['0a'] || {}) },
      '0b': { ...emptyBook(), peakNav: 50000, ...(raw.books?.['0b'] || {}) },
      '0c': { ...emptyBook(), peakNav: 5000, ...(raw.books?.['0c'] || {}) },
      '0d': { ...emptyBook(), peakNav: 100_000, ...(raw.books?.['0d'] || {}) },
      '0e': { ...emptyBook(), peakNav: 100_000, ...(raw.books?.['0e'] || {}) },
      '0f': { ...emptyBook(), peakNav: 100_000, ...(raw.books?.['0f'] || {}) },
      '0g': { ...emptyBook(), peakNav: 100_000, ...(raw.books?.['0g'] || {}) },
      '0h': { ...emptyBook(), peakNav: 100_000, ...(raw.books?.['0h'] || {}) }
    }
  };
  const week = weekStamp();
  if (state.day !== date) {
    state.day = date;
    for (const key of Object.keys(state.books)) {
      state.books[key].pnlDay = 0;
      state.books[key].rejectCount = 0;
    }
  }
  if (state.week !== week) {
    state.week = week;
    for (const key of Object.keys(state.books)) state.books[key].pnlWeek = 0;
  }
  if (!state.seenOrderIds || typeof state.seenOrderIds !== 'object') state.seenOrderIds = {};
  const live = state.books.live;
  state.kill = live.mode === 'KILL';
  state.killReason = live.reason;
  return state;
}

export async function saveRiskState(state) {
  await mkdir(dirname(RISK_STATE_PATH), { recursive: true });
  const next = {
    ...EMPTY,
    ...state,
    updatedAt: new Date().toISOString(),
    kill: state.books?.live?.mode === 'KILL',
    killReason: state.books?.live?.reason || null
  };
  await writeFile(RISK_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function bookState(state, book = 'live') {
  const key = bookKeyOf(book) || 'live';
  return state.books?.[key] || emptyBook();
}

export async function touchBook(state, book, patch) {
  const key = bookKeyOf(book) || 'live';
  const next = {
    ...state,
    books: {
      ...state.books,
      [key]: { ...emptyBook(), ...(state.books?.[key] || {}), ...patch }
    }
  };
  return saveRiskState(next);
}

export async function rememberOrder(state, decision) {
  const key = bookKeyOf(decision.book) || 'live';
  const slice = { ...emptyBook(), ...(state.books?.[key] || {}) };
  if (decision?.id) {
    const seen = { ...(state.seenOrderIds || {}) };
    seen[decision.id] = {
      ok: Boolean(decision.ok),
      code: decision.code,
      message: decision.message,
      at: new Date().toISOString(),
      symbol: decision.symbol,
      book: decision.book
    };
    const keys = Object.keys(seen);
    if (keys.length > 200) {
      for (const old of keys.slice(0, keys.length - 200)) delete seen[old];
    }
    state.seenOrderIds = seen;
  }
  if (decision && decision.replay !== true && decision.ok === false) {
    slice.rejectCount = (slice.rejectCount || 0) + 1;
  }
  if (decision?.mode && modeNeedsUpgrade(slice.mode, decision.mode)) {
    slice.mode = decision.mode;
    slice.reason = decision.modeReason || slice.reason;
    slice.at = new Date().toISOString();
  }
  state.books = { ...state.books, [key]: slice };
  state.lastCheck = {
    at: new Date().toISOString(),
    id: decision?.id || null,
    ok: decision?.ok,
    code: decision?.code,
    message: decision?.message,
    mode: slice.mode
  };
  const saved = await saveRiskState(state);
  await appendAudit({
    type: 'check',
    book: decision?.book,
    id: decision?.id,
    ok: decision?.ok,
    code: decision?.code,
    message: decision?.message,
    symbol: decision?.symbol,
    mode: slice.mode,
    quoteSeal: decision?.quoteSeal || null,
    quoteRef: decision?.quoteRef ?? null,
    limitPrice: decision?.order?.limitPrice ?? null
  });
  return saved;
}

function modeNeedsUpgrade(current, next) {
  return worseMode(current, next) === String(next || '').toUpperCase()
    && String(next || '').toUpperCase() !== String(current || 'NORMAL').toUpperCase();
}

export async function setMode(book, mode, { reason, confirm, actor } = {}) {
  const state = await loadRiskState();
  const key = bookKeyOf(book) || 'live';
  const slice = { ...emptyBook(), ...(state.books?.[key] || {}) };
  const next = String(mode || 'NORMAL').toUpperCase();
  if (!canRestore(slice.mode, next, { confirm })) {
    const denied = {
      ok: false,
      code: 'restore-requires-human',
      message: `${slice.mode} 只能人工确认后恢复，AI 不能自行降级`,
      mode: slice.mode
    };
    await appendAudit({ type: 'mode-denied', book: key, from: slice.mode, to: next, actor: actor || 'unknown' });
    return { ...denied, state };
  }
  slice.mode = next;
  slice.reason = next === 'NORMAL' ? null : (reason || slice.reason || 'manual');
  slice.at = new Date().toISOString();
  const saved = await touchBook(state, key, slice);
  await appendAudit({
    type: 'mode',
    book: key,
    from: state.books?.[key]?.mode,
    to: next,
    reason: slice.reason,
    actor: actor || (confirm ? 'human' : 'system'),
    confirm: Boolean(confirm)
  });
  return { ok: true, mode: next, reason: slice.reason, state: saved };
}

export async function setKill(reason, on = true, opts = {}) {
  if (on) return setMode('live', 'KILL', { reason: reason || 'manual', actor: opts.actor || 'human' });
  return setMode('live', 'NORMAL', { confirm: Boolean(opts.confirm), reason, actor: opts.actor || 'human' });
}
