import { createHash } from 'node:crypto';
import { evaluateFreshness } from './freshness.js';
import { canOpen, resolveMode } from './mode.js';
import { finiteNumber as num, instrumentOf } from '../numbers.js';

const THEMES = {
  nuclear: ['OKLO', 'SMR', 'NNE', 'UEC', 'CCJ'],
  space: ['ASTS', 'RKLB', 'LUNR'],
  ai: ['NVDA', 'CRDO', 'TEM', 'INOD', 'PLTR', 'MU'],
  bio: ['OSCR', 'HIMS'],
  china: ['KWEB', 'BABA', 'PDD', 'JD']
};

export function themeOf(symbol, explicit) {
  if (explicit) return String(explicit).toLowerCase();
  const key = String(symbol || '').toUpperCase();
  for (const [theme, names] of Object.entries(THEMES)) {
    if (names.includes(key)) return theme;
  }
  return 'other';
}

function deny(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function allow(extra = {}) {
  return { ok: true, code: 'pass', message: '通过 Risk Gateway', ...extra };
}

export function multiplierOf(order) {
  return String(order.instrument || 'equity').toLowerCase() === 'option' ? 100 : 1;
}

export function orderNotional(order) {
  const qty = num(order.qty);
  const price = num(order.limitPrice ?? order.price ?? order.last);
  if (qty == null || price == null) return null;
  return Math.abs(qty) * price * multiplierOf(order);
}

export function orderRisk(order) {
  const explicit = num(order.maxLoss);
  const qty = num(order.qty);
  const price = num(order.limitPrice ?? order.price ?? order.last);
  const stop = num(order.stopPrice);
  if (qty == null || price == null || stop == null || stop <= 0) {
    if (String(order.instrument || '').toLowerCase() === 'option') {
      const premium = orderNotional(order);
      return premium == null ? null : Math.max(premium, Math.abs(explicit || 0));
    }
    return null;
  }
  const computed = String(order.instrument || '').toLowerCase() === 'option'
    ? orderNotional(order) : Math.abs(price - stop) * Math.abs(qty);
  return Math.max(Math.abs(explicit || 0), computed);
}

export function findPosition(positions = [], order) {
  const symbol = String(order.symbol || '').toUpperCase();
  const instrument = instrumentOf(order.instrument);
  return (positions || []).find((row) => {
    if (String(row.symbol || '').toUpperCase() !== symbol) return false;
    const kind = instrumentOf(row.instrument || (row.expiration ? 'option' : 'equity'));
    if (kind !== instrument) return false;
    if (instrument === 'option' && order.expiration && row.expiration && row.expiration !== order.expiration) return false;
    if (instrument === 'option' && order.strike != null && row.strike != null && Number(row.strike) !== Number(order.strike)) return false;
    if (instrument === 'option' && (row.optionType || row.right) !== (order.optionType || order.right)) return false;
    return true;
  }) || null;
}

export function isReduce(order, positions = []) {
  const side = String(order.side || '').toLowerCase();
  const pos = findPosition(positions, order);
  const qty = num(order.qty) || 0;
  if (!pos || !(Math.abs(pos.qty) > 0)) return false;
  if (['sell', 'trim', 'exit', 'close'].includes(side)) return pos.qty > 0;
  if (side === 'buy' && pos.qty < 0) return true;
  return false;
}

function positionCount(positions = []) {
  const names = new Set();
  for (const row of positions || []) {
    if (Math.abs(Number(row.qty) || 0) <= 0) continue;
    names.add(String(row.symbol || '').toUpperCase());
  }
  return names.size;
}

export function positionRisk(row) {
  if (row == null) return null;
  const explicit = num(row.maxLoss);
  const qty = Math.abs(num(row.qty) || 0);
  const instrument = String(row.instrument || 'equity').toLowerCase();
  if (instrument === 'option') {
    const px = num(row.last ?? row.avgCost);
    if (px == null) return null;
    return Math.max(Math.abs(explicit || 0), qty * px * 100);
  }
  const entry = num(row.last ?? row.avgCost);
  const stop = num(row.stopPrice);
  if (qty && entry != null && stop > 0) return Math.max(Math.abs(explicit || 0), qty * Math.abs(entry - stop));
  return null;
}

function sumRisk(rows, onMissing) {
  let sum = 0;
  for (const row of rows || []) {
    const risk = positionRisk(row);
    if (risk == null) {
      if (onMissing === 'fail') return null;
      continue;
    }
    sum += risk;
  }
  return sum;
}

export function symbolRisk(positions = [], symbol) {
  const key = String(symbol || '').toUpperCase();
  return sumRisk((positions || []).filter((row) => String(row.symbol || '').toUpperCase() === key), 'fail');
}

export function themeRisk(positions = [], theme) {
  return sumRisk((positions || []).filter((row) => themeOf(row.symbol, row.theme) === theme), 'fail');
}

export function optionRiskTotal(positions = []) {
  return sumRisk((positions || []).filter((row) => String(row.instrument || '').toLowerCase() === 'option'), 'fail');
}

function optionDte(order) {
  if (order.dte != null && Number.isFinite(Number(order.dte))) return Number(order.dte);
  if (!order.expiration) return null;
  const exp = new Date(`${order.expiration}T20:00:00Z`);
  if (Number.isNaN(exp.getTime())) return null;
  return (exp.getTime() - Date.now()) / 86400000;
}

function freshnessOf(order, limits, now) {
  const inputs = order.inputs || {};
  return evaluateFreshness({
    last: order.last ?? inputs.last,
    quoteAt: inputs.quoteAt,
    quoteAgeSec: inputs.quoteAgeSec,
    fetchedAt: inputs.fetchedAt,
    intraLastTs: inputs.intraLastTs,
    hasQuote: inputs.hasQuote,
    hasIntra: inputs.hasIntra,
    hasChain: inputs.hasChain ?? (String(order.instrument || '') !== 'option'),
    chainOk: inputs.chainOk,
    chainAt: inputs.chainAt,
    chainAgeSec: inputs.chainAgeSec,
    intraAgeSec: inputs.intraAgeSec,
    requireQuote: true,
    requireIntra: Boolean(inputs.requireIntra),
    requireChain: String(order.instrument || '') === 'option',
    quoteMaxAgeSec: limits.quoteMaxAgeSec,
    chainMaxAgeSec: limits.chainMaxAgeSec,
    errors: inputs.errors
  }, now);
}

/**
 * 纯函数风控闸门。AI 不能改 limits。
 * book: { nav, cash, buyingPower, peakNav, positions, realizedPnlToday, realizedPnlWeek, mode, holdingsFresh }
 * limits.caps 为按净值算好的美元上限。
 */
export function assertOrder(order = {}, book = {}, limits = {}, extras = {}) {
  const now = extras.now || Date.now();
  const id = String(order.id || order.clientOrderId || '').trim();
  if (id && extras.seen?.[id]?.ok) {
    return deny('duplicate-order-id', '订单 ID 已使用；不得凭旧风控通过记录再次执行', { id, replay: true });
  }

  const bookKind = String(order.book || extras.book || 'live');
  const accountId = String(order.accountId || extras.accountId || '');
  const side = String(order.side || '').toLowerCase();
  const instrument = String(order.instrument || 'equity').toLowerCase();
  const qty = num(order.qty);
  const positions = book.positions || [];
  const reduce = isReduce(order, positions);
  const notional = orderNotional(order);
  const risk = orderRisk(order);
  const symbol = String(order.symbol || '').toUpperCase();
  const theme = themeOf(symbol, order.theme);
  const freshness = freshnessOf(order, limits, now);
  const caps = limits.caps || {};
  const modeInfo = resolveMode(book, { ...limits, caps }, {
    mode: book.mode || extras.mode,
    reason: book.modeReason || extras.modeReason,
    rejectCount: extras.rejectCount || 0
  });
  const mode = modeInfo.mode;

  const verdict = {
    id: id || null,
    book: bookKind,
    accountId,
    symbol,
    side,
    instrument,
    reduce,
    notional,
    risk,
    theme,
    mode,
    modeReason: modeInfo.reason,
    freshness,
    stopPrice: num(order.stopPrice),
    maxLoss: risk,
    caps
  };

  if (!symbol) return deny('missing-symbol', '缺少代码', verdict);
  if (!['buy', 'sell', 'add', 'trim', 'exit', 'close'].includes(side)) {
    return deny('bad-side', `方向无法识别：${order.side || ''}`, verdict);
  }
  if (qty == null || qty <= 0) return deny('bad-qty', '数量必须大于 0', verdict);
  if (!(notional > 0)) return deny('bad-price', '成交限价必须为正数', verdict);
  if (!reduce && !(num(book.nav) > 0)) return deny('nav-unknown', '账户净值未知或非正数', verdict);
  const referencePaper = !reduce && order.paperReference === true && String(bookKind).startsWith('paper') && (
    (instrument === 'option' && qty === 1) || (instrument === 'equity' && qty > 0)
  );
  if (!reduce && book.holdingsFresh === false && !referencePaper) return deny('holdings-stale', '已有持仓估值过期，禁止用旧净值扩大仓位', verdict);
  if (order.reduceOnly && !reduce) return deny('invalid-reduce-only', '方向不能减少现有持仓', verdict);
  if (!reduce && ['sell', 'trim', 'exit', 'close'].includes(side)) return deny('short-not-supported', '未实现完整空头保证金及借券风控，禁止新开空仓', verdict);
  if (!reduce && num(order.stopPrice) != null && num(order.stopPrice) >= num(order.limitPrice ?? order.price ?? order.last)) {
    return deny('bad-stop-side', '开多止损必须低于入场限价', verdict);
  }

  if (bookKind === 'live' && accountId && accountId !== 'agentic') {
    return deny('account-not-agentic', '实盘只允许 Agentic 账户下单', verdict);
  }
  if (bookKind === 'live' && (limits.phase ?? 1) < 1) {
    return deny('phase-paper-only', '当前 Phase 0，只许纸上实验仓下单', verdict);
  }

  if (!reduce && !canOpen(mode)) {
    return deny(
      mode === 'KILL' ? 'kill' : mode === 'PROTECT' ? 'protect' : 'reduce-only',
      `${mode}：禁止新开仓/加仓。${modeInfo.reason || ''}`.trim(),
      verdict
    );
  }

  if (!reduce && order.paperReference === true && !referencePaper) {
    return deny('reference-not-allowed', '参考报价只允许纸上期权小仓 1 张', verdict);
  }
  if (!reduce && !referencePaper && !freshness.fresh) {
    return deny(
      freshness.missing ? 'data-missing' : 'data-stale',
      `数据不新鲜，禁止开仓：${freshness.label}`,
      verdict
    );
  }
  if (!reduce) {
    const bound = limitTracksQuote(order);
    if (!bound.ok) return deny(bound.code, bound.message, verdict);
    verdict.quoteSeal = bound.seal;
    verdict.quoteRef = bound.ref;
  }

  const structure = String(order.structure || (instrument === 'option' && ['sell', 'trim'].includes(side) && !reduce ? 'naked_short' : 'long')).toLowerCase();
  if ((limits.forbidNakedShort !== false) && (structure === 'naked_short' || structure === 'unbounded')) {
    return deny('naked-short-forbidden', '禁止裸卖 / 无限责任结构', verdict);
  }

  if (!reduce && instrument === 'option' && limits.forbidShortDated !== false) {
    const dte = optionDte(order);
    if (dte != null && dte <= 1) {
      return deny('short-dated-forbidden', '初期白名单不含 0DTE/1DTE；已有仓减仓不受此限', verdict);
    }
  }
  if (!reduce) {
    const tif = String(order.type || order.orderType || 'limit').toLowerCase();
    if (tif === 'market') return deny('limit-only', '开仓默认限价单，不用无保护市价', verdict);
  }
  if (instrument === 'option' && limits.optionsLimitOnly !== false) {
    const tif = String(order.type || order.orderType || 'limit').toLowerCase();
    if (tif === 'market') return deny('options-limit-only', '期权只许限价单', verdict);
  }

  if (!reduce && limits.requireStopOnOpen !== false && !(num(order.stopPrice) > 0)) {
    return deny('stop-required', '开仓必须带券商侧止损价，否则整笔拒绝', verdict);
  }

  if (!reduce && risk == null) {
    return deny('uncomputable-loss', '算不清最大亏损，禁止开仓', verdict);
  }
  if (!reduce && caps.maxOrderRisk != null && risk != null && risk > Number(caps.maxOrderRisk) + 1e-6) {
    return deny('max-loss-exceeded', `本笔最大亏损 $${risk.toFixed(2)} 超过 ${limits.maxOrderRiskPct}% 净值（$${caps.maxOrderRisk.toFixed(2)}）`, verdict);
  }

  const bp = num(book.buyingPower ?? book.cash);
  if (!reduce && ['buy', 'add'].includes(side)) {
    if (bp == null) return deny('buying-power-unknown', '购买力未知，禁止开仓', verdict);
    const reserved = (book.openOrders || []).filter((row) => !isReduce(row, positions)).reduce((sum, row) => sum + (orderNotional(row) ?? Infinity), 0);
    if (notional + reserved > bp + 1e-6) {
      return deny('buying-power', `购买力 $${bp.toFixed(2)} 不够覆盖约 $${notional.toFixed(2)}`, verdict);
    }
  }

  if (reduce) {
    const pos = findPosition(positions, order);
    if (!pos || Math.abs(Number(pos.qty) || 0) < qty - 1e-9) {
      return deny('insufficient-position', '没有足够持仓可减', verdict);
    }
  } else {
    const pending = (book.openOrders || []).filter((row) => !isReduce(row, positions));
    const currentCount = positionCount([...positions, ...pending]);
    const already = Boolean(findPosition(positions, order));
    if (!already && caps.maxPositions != null && currentCount >= Number(caps.maxPositions)) {
      return deny('max-positions', `方向仓 ${currentCount}（含待成交）已达上限 ${caps.maxPositions}`, verdict);
    }
    const exposure = [...positions, ...pending.map((row) => ({ ...row, last: row.limitPrice ?? row.price ?? row.last }))];
    const existingSymbol = symbolRisk(exposure, symbol);
    if (existingSymbol == null) {
      return deny('uncomputable-loss', `${symbol} 已有仓算不清风险，禁止再加`, verdict);
    }
    const afterSymbol = (existingSymbol || 0) + (risk || 0);
    if (caps.maxSingleRisk != null && afterSymbol > Number(caps.maxSingleRisk) + 1e-6) {
      return deny('max-single-risk', `单标风险约 $${afterSymbol.toFixed(2)} 超过 ${limits.maxSingleRiskPct}% 净值（$${caps.maxSingleRisk.toFixed(2)}）`, verdict);
    }
    const existingTheme = themeRisk(exposure, theme);
    if (theme !== 'other' && existingTheme == null) return deny('uncomputable-theme-risk', '同主题已有仓风险未知，禁止增加', verdict);
    const afterTheme = (existingTheme || 0) + (risk || 0);
    if (theme !== 'other' && caps.maxThemeRisk != null && afterTheme > Number(caps.maxThemeRisk) + 1e-6) {
      return deny('max-theme', `${theme} 主题风险约 $${afterTheme.toFixed(2)} 超过 ${limits.maxThemeRiskPct}% 净值（$${caps.maxThemeRisk.toFixed(2)}）`, verdict);
    }
    if (instrument === 'option' && caps.maxOptionRisk != null) {
      const existingOpt = optionRiskTotal(exposure);
      if (existingOpt == null) return deny('uncomputable-option-risk', '已有期权风险未知', verdict);
      const afterOpt = existingOpt + (risk || 0);
      if (afterOpt > Number(caps.maxOptionRisk) + 1e-6) {
        return deny('max-option-risk', `期权权利金/最大损失合计 $${afterOpt.toFixed(2)} 超过 ${limits.maxOptionRiskPct}% 净值`, verdict);
      }
    }
  }

  return allow(verdict);
}

/** 开仓限价必须贴着这次取到的报价。偏离超过 1.5% 视为报价和订单不是同一笔。 */
export function limitTracksQuote(order = {}) {
  const inputs = order.inputs || {};
  const instrument = String(order.instrument || 'equity').toLowerCase();
  const buying = ['buy', 'add'].includes(String(order.side || '').toLowerCase());
  const ref = instrument === 'option'
    ? num(buying ? (inputs.ask ?? order.ask ?? inputs.last ?? order.last) : (inputs.bid ?? order.bid ?? inputs.last ?? order.last))
    : num(inputs.last ?? order.last);
  const limit = num(order.limitPrice ?? order.price);
  if (!(ref > 0) || !(limit > 0)) return { ok: false, code: 'quote-unbound', message: '开仓限价没有绑定这次报价' };
  if (Math.abs(limit - ref) / ref > 0.015 + 1e-9) {
    return { ok: false, code: 'limit-away-from-quote', message: `限价 ${limit} 偏离这次报价 ${ref} 超过 1.5%` };
  }
  const seal = createHash('sha256').update(JSON.stringify({
    symbol: String(order.symbol || '').toUpperCase(),
    quoteAt: inputs.quoteAt ?? null,
    ref,
    bid: num(inputs.bid ?? order.bid),
    ask: num(inputs.ask ?? order.ask)
  })).digest('hex').slice(0, 16);
  return { ok: true, ref, seal };
}
