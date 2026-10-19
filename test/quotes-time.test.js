import test from 'node:test';
import assert from 'node:assert/strict';
import { nasdaqSummaryMarketCap, parseNasdaqTradeTime } from '../src/quotes.js';

test('nasdaq summary market cap parses the comma-formatted total', () => {
  assert.equal(nasdaqSummaryMarketCap({ data: { summaryData: { MarketCap: { value: '31,915,305,131' } } } }), 31915305131);
  assert.equal(nasdaqSummaryMarketCap({ data: { summaryData: { MarketCap: { value: '$6.7B' } } } }), null);
  assert.equal(nasdaqSummaryMarketCap({ data: { summaryData: {} } }), null);
  assert.equal(nasdaqSummaryMarketCap(null), null);
});

test('nasdaq info timestamp is exchange time, not the chart bar', () => {
  assert.equal(parseNasdaqTradeTime('Sep 28, 2026 10:22 AM ET'), Date.parse('2026-09-28T14:22:00Z'));
  assert.equal(parseNasdaqTradeTime('Jan 6, 2026 9:30 AM ET'), Date.parse('2026-01-06T14:30:00Z'));
  assert.equal(parseNasdaqTradeTime(''), null);
});
