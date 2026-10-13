export const PUBLIC_DEMO_ID = 'public-demo';
export const PUBLIC_DEMO_TITLE = 'Public demo';
export const PUBLIC_DEMO_NOTE = '观察清单缺失，已回退到内置 public-demo 池（AAPL、MSFT、GOOGL、AMZN、META、NVDA、AVGO、JPM、V、MU）。这不是你的自选清单。';

export const PUBLIC_DEMO_UNIVERSE = [
  { symbol: 'AAPL', cik: '0000320193', sector: 'Technology' },
  { symbol: 'MSFT', cik: '0000789019', sector: 'Technology' },
  { symbol: 'GOOGL', cik: '0001652044', sector: 'Communication Services' },
  { symbol: 'AMZN', cik: '0001018724', sector: 'Consumer Discretionary' },
  { symbol: 'META', cik: '0001326801', sector: 'Communication Services' },
  { symbol: 'NVDA', cik: '0001045810', sector: 'Technology' },
  { symbol: 'AVGO', cik: '0001730168', sector: 'Technology' },
  { symbol: 'JPM', cik: '0000019617', sector: 'Financials', valuationType: 'bank' },
  { symbol: 'V', cik: '0001403161', sector: 'Financials' },
  { symbol: 'MU', cik: '0000723125', sector: 'Technology' }
];

export function demoWatchlist() {
  const symbols = PUBLIC_DEMO_UNIVERSE.map((row) => row.symbol);
  return {
    id: PUBLIC_DEMO_ID,
    title: PUBLIC_DEMO_TITLE,
    filename: null,
    filePath: null,
    updated: null,
    modifiedAt: null,
    symbols,
    total: symbols.length,
    note: PUBLIC_DEMO_NOTE,
    fallback: PUBLIC_DEMO_ID
  };
}

export function demoResearchUniverse() {
  const symbols = PUBLIC_DEMO_UNIVERSE.map((row) => ({
    symbol: row.symbol,
    lists: [PUBLIC_DEMO_TITLE],
    buckets: ['other']
  }));
  return {
    lists: [{
      file: null,
      title: PUBLIC_DEMO_TITLE,
      bucket: 'other',
      count: symbols.length,
      symbols: symbols.map((row) => row.symbol)
    }],
    symbols,
    bySymbol: Object.fromEntries(symbols.map((row) => [row.symbol, { ...row }])),
    error: null,
    fallback: PUBLIC_DEMO_ID,
    note: PUBLIC_DEMO_NOTE
  };
}
