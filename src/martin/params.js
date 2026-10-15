/** Martin Luk 启发研究默认。扫描门槛来自 2025-02-02 本人回复【M2】；归一化口径是工程近似【A】，待回测。 */

export const MARTIN_ADVICE_SCHEMA = 'martin-luk-advice-v1';

export const OWNER_BOT = 'Kawaii小胡';
export const AUDIENCE = 'Kawaii美股';

export const SOURCE_DOC = 'rules/martin-luk-strategy-source-v1.md';
export const PLAYBOOK_DOC = 'rules/martin-luk-inspired-v1.md';
export const MODULE_DOC = 'docs/martin-luk-advice-v1.md';

export const POST_FILL_STOP_ITEM = '成交后立刻挂 GTC stop';

/** 观察名单优先，再用这组高流动性美股补齐。不含 SPY/QQQ，那两个只参与市场状态。 */
export const MAJOR_LIQUID_US = Object.freeze([
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'AVGO', 'TSLA',
  'AMD', 'MU', 'NFLX', 'JPM', 'V', 'LLY', 'COST', 'CRM'
]);

/** 按需生成时的扫描上限【A】。调用方传入 symbols 时不截断。 */
export const SCAN_CAP = 36;

export const MARTIN_SCAN_DEFAULTS = Object.freeze({
  label: '待回测',
  pendingBacktest: true,
  potent: Object.freeze({
    source: 'M2',
    marketCapGtUsd: 100_000_000,
    volatility1wGtPct: 3.5,
    closeGtEma21: true,
    volumeTimesPriceGtUsd: 50_000_000
  }),
  premarket: Object.freeze({
    source: 'M2',
    marketCapGtUsd: 100_000_000,
    avgVolume10dGtShares: 500_000,
    volumeTimesPriceGtUsd: 50_000_000,
    sort: 'premarket_change_pct_desc'
  }),
  leader: Object.freeze({
    source: 'M2',
    marketCapGtUsd: 100_000_000,
    avgVolume10dGtShares: 500_000,
    volumeTimesPrice1wGtUsd: 300_000_000,
    sort: 'performance_1month_desc'
  })
});

export const ADVICE_FLAGS = Object.freeze({
  schema: MARTIN_ADVICE_SCHEMA,
  ownerBot: OWNER_BOT,
  audience: AUDIENCE,
  account7811: 'observation-paper',
  referenceOnly: true,
  liveTrading: false,
  liveTradingAuthority: false,
  placesOrders: false,
  autoTrade7811: false,
  brokerOrders: false,
  optionsInScope: false,
  pendingBacktest: true,
  label: '待回测',
  replacesExistingGates: false
});
