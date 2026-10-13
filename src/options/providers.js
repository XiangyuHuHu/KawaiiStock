import { finiteNumber as num } from '../numbers.js';

const asList = value => Array.isArray(value) ? value : value ? [value] : [];
const ms = value => { const n = num(value); return n > 1e12 ? n : null; };
const root = value => String(value || '').replace(/[./]/g, '').toUpperCase();

export function providerStatus(env = process.env) {
  const configured = Boolean(env.TRADIER_TOKEN?.trim());
  const sandbox = env.TRADIER_SANDBOX === '1';
  return { provider: configured ? 'tradier' : 'yahoo/nasdaq', configured, sandbox,
    quoteCapability: configured && !sandbox ? 'provider-timestamped' : 'reference-only',
    message: configured ? (sandbox ? 'Tradier 沙盒为延迟行情，不能通过实时校验' : '已配置 Tradier；每次仍按双边源时间验证，不保证报价新鲜') : 'Yahoo/Nasdaq 没有每腿 Bid/Ask 时间。Tradier 正式行情的 bid_date/ask_date 可以补上。Market Data 的 updated 也能补，免费档是约 24 小时延迟，过不了 180 秒校验。沙盒和延迟行情都不能当成实时。' };
}

export function mapTradierContract(row, { sandbox = false } = {}) {
  const bidAt = ms(row.bid_date), askAt = ms(row.ask_date);
  const standard = num(row.contract_size) === 100 && root(row.root_symbol) === root(row.underlying) && Boolean(row.root_symbol);
  return { contractSymbol: row.symbol, underlying: row.underlying, type: row.option_type,
    expiration: row.expiration_date, strike: num(row.strike), bid: num(row.bid), ask: num(row.ask),
    mid: num(row.bid) != null && num(row.ask) != null ? (num(row.bid) + num(row.ask)) / 2 : null,
    last: num(row.last), volume: num(row.volume), openInterest: num(row.open_interest),
    // ORATS IV is not a real-time quote; derive IV from current bid/ask instead.
    iv: null, vendorIv: num(row.greeks?.mid_iv), vendorIvAt: row.greeks?.updated_at || null,
    bidAt, askAt, quoteAt: bidAt && askAt ? Math.min(bidAt, askAt) : null,
    lastTradeAt: ms(row.trade_date), quoteSource: 'tradier', quoteMode: sandbox ? 'delayed' : 'consolidated',
    standard, multiplier: standard ? 100 : null, unitSource: 'provider-contract-size-and-root' };
}

export async function tradierGet(path, params, { env = process.env, fetcher = fetch } = {}) {
  if (!env.TRADIER_TOKEN?.trim()) throw new Error('Tradier 行情权限未配置');
  if (!['/markets/options/expirations', '/markets/options/chains', '/markets/quotes'].includes(path)) throw new Error('只允许行情读取端点');
  const host = env.TRADIER_SANDBOX === '1' ? 'sandbox.tradier.com' : 'api.tradier.com';
  const response = await fetcher(`https://${host}/v1${path}?${new URLSearchParams(params)}`, {
    method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${env.TRADIER_TOKEN}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Tradier 行情请求 HTTP ${response.status}（检查权限或限额）`);
  const data = await response.json();
  if (data.errors) throw new Error('Tradier 未返回可用行情');
  return data;
}

export async function loadTradierChain(symbol, expirationUnix, deps = {}) {
  const env = deps.env || process.env;
  let dates;
  if (expirationUnix) dates = [new Date(expirationUnix * 1000).toISOString().slice(0, 10)];
  else {
    const data = await tradierGet('/markets/options/expirations', { symbol, includeAllRoots: 'false' }, deps);
    dates = asList(data.expirations?.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  }
  if (!dates.length) throw new Error('Tradier 没有到期日');
  const [chain, underlying] = await Promise.all([
    tradierGet('/markets/options/chains', { symbol, expiration: dates[0], greeks: 'false' }, deps),
    tradierGet('/markets/quotes', { symbols: symbol }, deps)
  ]);
  const legs = asList(chain.options?.option).map(row => mapTradierContract(row, { sandbox: env.TRADIER_SANDBOX === '1' }));
  const q = asList(underlying.quotes?.quote).find(q => root(q.symbol) === root(symbol));
  return { ok: legs.length > 0, symbol, source: 'tradier', error: legs.length ? null : 'Tradier 到期日下没有合约',
    last: num(q?.last), underlyingQuoteAt: ms(q?.trade_date), underlyingSource: 'tradier',
    assetType: q?.type === 'etf' ? 'etf' : q?.type === 'stock' ? 'equity' : null,
    earningsTs: null, expiration: dates[0], expirationDates: dates.map(d => Date.parse(`${d}T00:00:00Z`) / 1000),
    calls: legs.filter(l => l.type === 'call'), puts: legs.filter(l => l.type === 'put'), fetchedAt: Date.now() };
}
