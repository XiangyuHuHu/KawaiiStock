import fs from "node:fs/promises";
import path from "node:path";
import { PUBLIC_DEMO_UNIVERSE, demoWatchlist } from "../demo-pool.js";
import { OBSIDIAN_LISTS } from "../paths.js";
import { rememberTape } from "../tape.js";
import { adjustCyclicalValuation, anomalyFromMargin, fundamentalsStale } from "../valuation-guards.js";
import { getChinaPayload } from "./cn-market-data.mjs";

const FALLBACK_UNIVERSE = PUBLIC_DEMO_UNIVERSE;

const WATCHLIST_DIR = process.env.KAWAII_LIST_DIR || OBSIDIAN_LISTS;
const responseCache = new Map();
const stockDataCache = new Map();
const fullWatchlistCache = new Map();
const fxRateCache = new Map();
let companyTickerLookupPromise = null;

const SUPPORTED_FILINGS = new Set([
  "10-K", "10-Q", "10-K/A", "10-Q/A",
  "20-F", "20-F/A", "40-F", "40-F/A", "6-K", "6-K/A",
]);

const SEC_HEADERS = {
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate",
  "User-Agent": "ValuEdge research prototype open-source-research",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeNumber = (value) => {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseMarketNumber = (value) => {
  if (value == null) return null;
  return safeNumber(String(value).replace(/[$,%+\s]/g, "").replace("N/A", ""));
};

function matchesPreset(stock, presetId) {
  const rules = {
    all: () => true,
    undervalued: (item) => item.marginOfSafety > 0,
    "high-safety": (item) => item.marginOfSafety >= 20,
    "positive-fcf": (item) => item.freeCashFlow > 0 && item.marginOfSafety > 0,
    "quality-value": (item) => item.qualityScore >= 65 && item.marginOfSafety >= 5,
    dividend: (item) => item.dividendYield > 0 && item.marginOfSafety > 0,
    "large-cap": (item) => item.marketCap >= 200_000_000_000 && item.marginOfSafety > 0,
    quality: (item) => item.qualityScore >= 68 && item.freeCashFlow > 0,
    capitulation: (item) => item.qualityScore >= 65 && (item.drawdown30d <= -7 || item.dailyChange <= -3),
  };
  return (rules[presetId] ?? rules.all)(stock);
}

function watchlistIdFromFilename(filename) {
  if (filename.startsWith("01")) return "kawaii-curated";
  if (filename.startsWith("02")) return "ahu-picks";
  if (filename.startsWith("03")) return "tenbagger";
  return filename.replace(/\.md$/i, "").replace(/^\d+\s*/, "").replace(/\s+/g, "-").toLowerCase();
}

export async function loadWatchlists() {
  try {
    const entries = await fs.readdir(WATCHLIST_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && !entry.name.startsWith("00"))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    const watchlists = [];
    for (const file of files) {
      const fullPath = path.join(WATCHLIST_DIR, file.name);
      const [content, stats] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
      const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? file.name.replace(/\.md$/i, "");
      const declaredUpdated = content.match(/^updated:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const symbols = [];
      const seen = new Set();
      for (const match of content.matchAll(/\|\s*\*\*([A-Z][A-Z0-9.\-]{0,9})\*\*\s*\|/g)) {
        const symbol = match[1].toUpperCase();
        if (!seen.has(symbol)) {
          seen.add(symbol);
          symbols.push(symbol);
        }
      }
      watchlists.push({
        id: watchlistIdFromFilename(file.name),
        title,
        filename: file.name,
        filePath: fullPath,
        updated: declaredUpdated ?? stats.mtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        symbols,
        total: symbols.length,
      });
    }
    if (watchlists.length) return watchlists;
  } catch (error) {
    console.warn(`Unable to read KawaiiList: ${error.message}`);
  }

  return [demoWatchlist()];
}

async function getCompanyTickerLookup() {
  if (!companyTickerLookupPromise) {
    companyTickerLookupPromise = fetchJson("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS }, 30000)
      .then((data) => {
        const lookup = new Map();
        for (const company of Object.values(data ?? {})) {
          if (!company?.ticker || company.cik_str == null) continue;
          lookup.set(String(company.ticker).toUpperCase(), {
            cik: String(company.cik_str).padStart(10, "0"),
            company: company.title,
          });
        }
        return lookup;
      })
      .catch((error) => {
        companyTickerLookupPromise = null;
        throw error;
      });
  }
  return companyTickerLookupPromise;
}

async function fetchJson(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getFactNode(companyFacts, namespace, tag) {
  return companyFacts?.facts?.[namespace]?.[tag] ?? null;
}

function getUnitPoints(node, requestedUnit) {
  const units = node?.units ?? {};
  if (Array.isArray(units[requestedUnit])) {
    return units[requestedUnit].map((point) => ({ ...point, __unit: requestedUnit }));
  }
  let fallbackUnit = null;
  if (requestedUnit === "USD") {
    fallbackUnit = Object.keys(units).find((unit) => /^[A-Z]{3}$/.test(unit));
  } else if (requestedUnit === "USD/shares") {
    fallbackUnit = Object.keys(units).find((unit) => /^[A-Z]{3}\/shares$/.test(unit));
  }
  return fallbackUnit && Array.isArray(units[fallbackUnit])
    ? units[fallbackUnit].map((point) => ({ ...point, __unit: fallbackUnit }))
    : [];
}

function selectFacts(companyFacts, namespace, tags, unit, kind = "duration") {
  for (const tag of tags) {
    const node = getFactNode(companyFacts, namespace, tag);
    const points = getUnitPoints(node, unit);
    if (!points.length) continue;

    const filtered = points.filter((point) => {
      if (!SUPPORTED_FILINGS.has(point.form)) return false;
      if (safeNumber(point.val) == null) return false;
      if (kind === "annual") {
        if (point.fp !== "FY" || !point.start) return false;
        const duration = (Date.parse(point.end) - Date.parse(point.start)) / 86400000;
        return duration >= 300 && duration <= 430;
      }
      return true;
    });

    if (!filtered.length) continue;
    const byPeriod = new Map();
    for (const point of filtered) {
      const key = kind === "annual" ? point.end : `${point.end}-${point.fp ?? ""}`;
      const existing = byPeriod.get(key);
      if (!existing || String(point.filed) > String(existing.filed)) byPeriod.set(key, point);
    }
    return [...byPeriod.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
  }
  return [];
}

function latestAnnual(companyFacts, tags, unit = "USD") {
  const series = selectFacts(companyFacts, "us-gaap", tags, unit, "annual");
  return series.at(-1) ?? null;
}

function selectAccountingFacts(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD", kind = "duration") {
  const usGaap = selectFacts(companyFacts, "us-gaap", usGaapTags, unit, kind);
  if (usGaap.length) return usGaap;
  return selectFacts(companyFacts, "ifrs-full", ifrsTags, unit, kind);
}

function latestAccountingAnnual(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD") {
  return selectAccountingFacts(companyFacts, usGaapTags, ifrsTags, unit, "annual").at(-1) ?? null;
}

function latestInstant(companyFacts, namespace, tags, unit = "USD") {
  const candidates = tags.flatMap((tag) => {
    const node = getFactNode(companyFacts, namespace, tag);
    return getUnitPoints(node, unit)
      .filter((point) => SUPPORTED_FILINGS.has(point.form))
      .map((point) => ({ ...point, tag }));
  });
  return candidates.sort((a, b) => `${a.end}-${a.filed}`.localeCompare(`${b.end}-${b.filed}`)).at(-1) ?? null;
}

function annualPair(companyFacts, tags, unit = "USD") {
  return selectFacts(companyFacts, "us-gaap", tags, unit, "annual").slice(-2);
}

function annualSeries(companyFacts, tags, unit = "USD", limit = 6) {
  return selectFacts(companyFacts, "us-gaap", tags, unit, "annual").slice(-limit);
}

function latestAccountingInstant(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD") {
  const usGaap = latestInstant(companyFacts, "us-gaap", usGaapTags, unit);
  return usGaap ?? latestInstant(companyFacts, "ifrs-full", ifrsTags, unit);
}

function accountingAnnualPair(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD") {
  return selectAccountingFacts(companyFacts, usGaapTags, ifrsTags, unit, "annual").slice(-2);
}

function accountingAnnualSeries(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD", limit = 6) {
  return selectAccountingFacts(companyFacts, usGaapTags, ifrsTags, unit, "annual").slice(-limit);
}

function largestAccountingAnnualSeries(companyFacts, usGaapTags, ifrsTags = usGaapTags, unit = "USD", limit = 6) {
  const candidates = [
    ...usGaapTags.map((tag) => selectFacts(companyFacts, "us-gaap", [tag], unit, "annual")),
    ...ifrsTags.map((tag) => selectFacts(companyFacts, "ifrs-full", [tag], unit, "annual")),
  ].filter((series) => series.length);
  if (!candidates.length) return [];
  const best = candidates.sort((left, right) => {
    const leftValue = Math.abs(safeNumber(left.at(-1)?.val) ?? 0);
    const rightValue = Math.abs(safeNumber(right.at(-1)?.val) ?? 0);
    return rightValue - leftValue || right.length - left.length;
  })[0];
  return best.slice(-limit);
}

function currencyFromUnit(unit) {
  const match = String(unit ?? "").match(/^([A-Z]{3})(?:\/shares)?$/);
  return match?.[1] ?? "USD";
}

async function getUsdFxRate(currency) {
  if (!currency || currency === "USD") return 1;
  const cached = fxRateCache.get(currency);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;
  const data = await fetchJson(`https://api.frankfurter.app/latest?from=${encodeURIComponent(currency)}&to=USD`, {}, 15000);
  const rate = safeNumber(data?.rates?.USD);
  if (!(rate > 0)) throw new Error(`No ${currency}/USD FX rate`);
  fxRateCache.set(currency, { rate, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return rate;
}

function factValue(point, fxRate = 1) {
  const value = safeNumber(point?.val);
  if (value == null) return null;
  const currency = currencyFromUnit(point?.__unit);
  return currency === "USD" ? value : value * fxRate;
}

function calculateDcfPerShare({ fcfPerShare, growth, wacc, terminalGrowth, netDebtPerShare = 0 }) {
  if (!(fcfPerShare > 0)) return null;
  const discountRate = wacc / 100;
  const terminalRate = terminalGrowth / 100;
  if (!(discountRate > terminalRate)) return null;
  const firstStageGrowth = growth / 100;
  let projectedFcf = fcfPerShare;
  let presentValue = 0;
  for (let year = 1; year <= 5; year += 1) {
    projectedFcf *= 1 + firstStageGrowth;
    presentValue += projectedFcf / ((1 + discountRate) ** year);
  }
  const terminalValue = projectedFcf * (1 + terminalRate) / (discountRate - terminalRate);
  return Math.max(0, presentValue + terminalValue / ((1 + discountRate) ** 5) - netDebtPerShare);
}

function solveImpliedGrowth({ price, fcfPerShare, wacc, terminalGrowth, netDebtPerShare }) {
  if (!(price > 0) || !(fcfPerShare > 0)) return null;
  let low = -20;
  let high = 60;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const midpoint = (low + high) / 2;
    const value = calculateDcfPerShare({ fcfPerShare, growth: midpoint, wacc, terminalGrowth, netDebtPerShare });
    if (value == null) return null;
    if (value < price) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

async function fetchQuote(symbol) {
  const configuredProvider = process.env.MARKET_DATA_PROVIDER?.toLowerCase();
  const twelveDataKey = process.env.TWELVE_DATA_API_KEY;

  if (configuredProvider === "twelve-data" && twelveDataKey) {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1day");
    url.searchParams.set("outputsize", "30");
    url.searchParams.set("apikey", twelveDataKey);
    const data = await fetchJson(url, {}, 15000);
    if (data.status === "error") throw new Error(data.message ?? "Twelve Data error");
    const values = (data.values ?? []).map((value) => ({
      date: value.datetime,
      open: safeNumber(value.open),
      close: safeNumber(value.close),
    }));
    const latest = values[0];
    const previous = values[1];
    return {
      price: latest?.close,
      previousClose: previous?.close,
      marketDate: latest?.date,
      thirtyDayHigh: Math.max(...values.map((value) => value.close).filter(Boolean)),
      source: "Twelve Data",
    };
  }

  const nasdaqHeaders = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.nasdaq.com",
    Referer: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
  };
  const [data, summary, forecast] = await Promise.all([
    fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`, {
      headers: nasdaqHeaders,
    }, 15000),
    fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`, {
      headers: nasdaqHeaders,
    }, 15000),
    fetchJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-forecast`, {
      headers: nasdaqHeaders,
    }, 15000).catch(() => null),
  ]);
  const primary = data?.data?.primaryData ?? {};
  const summaryData = summary?.data?.summaryData ?? {};
  const price = parseMarketNumber(primary.lastSalePrice);
  const changePercent = parseMarketNumber(primary.percentageChange);
  const yearlyForecast = forecast?.data?.yearlyForecast?.rows ?? [];
  const currentYearForecast = yearlyForecast.find((row) => safeNumber(row.consensusEPSForecast) > 0) ?? null;
  const nextYearForecast = yearlyForecast.find((row) => row !== currentYearForecast && safeNumber(row.consensusEPSForecast) > 0) ?? null;
  return {
    price,
    previousClose: parseMarketNumber(summaryData.PreviousClose?.value) ?? (price && changePercent != null ? price / (1 + changePercent / 100) : null),
    marketDate: primary.lastTradeTimestamp ?? data?.data?.secondaryData?.lastTradeTimestamp ?? null,
    thirtyDayHigh: null,
    marketCap: parseMarketNumber(summaryData.MarketCap?.value),
    sector: summaryData.Sector?.value && summaryData.Sector.value !== "N/A" ? summaryData.Sector.value : null,
    earningsDate: summaryData.EarningsDate?.value || summaryData.NextEarningsDate?.value || forecast?.data?.earningsDate || forecast?.data?.nextEarningsDate || null,
    forwardEps: safeNumber(currentYearForecast?.consensusEPSForecast),
    forwardEpsHigh: safeNumber(currentYearForecast?.highEPSForecast),
    forwardEpsLow: safeNumber(currentYearForecast?.lowEPSForecast),
    forwardEpsYear: currentYearForecast?.fiscalEnd ?? null,
    forwardEpsEstimates: safeNumber(currentYearForecast?.noOfEstimates),
    nextYearEps: safeNumber(nextYearForecast?.consensusEPSForecast),
    nextYearEpsYear: nextYearForecast?.fiscalEnd ?? null,
    source: "Nasdaq public quote feed",
  };
}

async function fetchCompanyFacts(cik) {
  return fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_HEADERS }, 35000);
}

async function buildValuation(meta, quote, companyFacts) {
  const revenueTags = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ];
  const revenueHistory = largestAccountingAnnualSeries(companyFacts, revenueTags, ["Revenue"]);
  const revenueSeries = revenueHistory.slice(-2);
  const netIncomeHistory = accountingAnnualSeries(companyFacts, ["NetIncomeLoss", "ProfitLoss"], ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"]);
  const operatingCashHistory = accountingAnnualSeries(companyFacts, ["NetCashProvidedByUsedInOperatingActivities"], ["CashFlowsFromUsedInOperatingActivities"]);
  const capexHistory = accountingAnnualSeries(companyFacts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsForPropertyPlantAndEquipment",
    "PropertyPlantAndEquipmentAdditions",
  ], ["PurchaseOfPropertyPlantAndEquipment", "PaymentsToAcquirePropertyPlantAndEquipment"]);
  const epsHistory = accountingAnnualSeries(companyFacts, ["EarningsPerShareDiluted", "EarningsPerShareBasic"], ["DilutedEarningsLossPerShare", "BasicEarningsLossPerShare"], "USD/shares");
  const shareHistory = accountingAnnualSeries(companyFacts, ["WeightedAverageNumberOfDilutedSharesOutstanding"], ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstanding"], "shares");
  const grossProfitHistory = accountingAnnualSeries(companyFacts, ["GrossProfit"], ["GrossProfit"]);
  const operatingIncomeHistory = accountingAnnualSeries(companyFacts, ["OperatingIncomeLoss"], ["ProfitLossFromOperatingActivities", "OperatingProfitLoss"]);
  const reportingCurrency = currencyFromUnit(
    revenueSeries.at(-1)?.__unit ?? netIncomeHistory.at(-1)?.__unit ?? operatingCashHistory.at(-1)?.__unit,
  );
  let fxRate = 1;
  try {
    fxRate = await getUsdFxRate(reportingCurrency);
  } catch (error) {
    throw new Error(`Unable to convert ${reportingCurrency} financials to USD: ${error.message}`);
  }
  const toUsd = (point) => factValue(point, fxRate);
  const revenue = toUsd(revenueSeries.at(-1));
  const priorRevenue = toUsd(revenueSeries.at(-2));
  const revenueGrowth = revenue && priorRevenue ? revenue / priorRevenue - 1 : null;

  const netIncomeFact = latestAccountingAnnual(companyFacts, ["NetIncomeLoss", "ProfitLoss"], ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"]);
  const operatingCashFact = latestAccountingAnnual(companyFacts, ["NetCashProvidedByUsedInOperatingActivities"], ["CashFlowsFromUsedInOperatingActivities"]);
  const capexFact = latestAccountingAnnual(companyFacts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsForPropertyPlantAndEquipment",
    "PropertyPlantAndEquipmentAdditions",
  ], ["PurchaseOfPropertyPlantAndEquipment", "PaymentsToAcquirePropertyPlantAndEquipment"]);
  const equityFact = latestAccountingInstant(companyFacts, [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ], ["Equity", "EquityAttributableToOwnersOfParent"]);
  const sharesFact =
    latestAccountingAnnual(companyFacts, ["WeightedAverageNumberOfDilutedSharesOutstanding"], ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstanding"], "shares") ??
    latestInstant(companyFacts, "dei", ["EntityCommonStockSharesOutstanding"], "shares");
  const epsFact = latestAccountingAnnual(companyFacts, ["EarningsPerShareDiluted", "EarningsPerShareBasic"], ["DilutedEarningsLossPerShare", "BasicEarningsLossPerShare"], "USD/shares");
  const dividendFact = latestAccountingAnnual(companyFacts, [
    "CommonStockDividendsPerShareDeclared",
    "CommonStockDividendsPerShareCashPaid",
  ], ["DividendsPaidPerShare", "DividendsRecognisedAsDistributionsToOwnersPerShare"], "USD/shares");
  const assetsFact = latestAccountingInstant(companyFacts, ["Assets"], ["Assets"]);
  const liabilitiesFact = latestAccountingInstant(companyFacts, ["Liabilities"], ["Liabilities"]);
  const cashFact = latestAccountingInstant(companyFacts, [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ], ["CashAndCashEquivalents"]);
  const shortDebtFact = latestAccountingInstant(companyFacts, ["ShortTermBorrowings", "LongTermDebtCurrent"], ["BorrowingsCurrent", "CurrentBorrowings"]);
  const longDebtFact = latestAccountingInstant(companyFacts, ["LongTermDebtNoncurrent", "LongTermDebt"], ["BorrowingsNoncurrent", "NoncurrentBorrowings"]);
  const currentAssetsFact = latestAccountingInstant(companyFacts, ["AssetsCurrent"], ["CurrentAssets"]);
  const currentLiabilitiesFact = latestAccountingInstant(companyFacts, ["LiabilitiesCurrent"], ["CurrentLiabilities"]);
  const interestExpenseFact = latestAccountingAnnual(companyFacts, ["InterestExpenseNonOperating", "InterestAndDebtExpense"], ["FinanceCosts"]);
  const grossProfitFact = latestAccountingAnnual(companyFacts, ["GrossProfit"], ["GrossProfit"]);
  const operatingIncomeFact = latestAccountingAnnual(companyFacts, ["OperatingIncomeLoss"], ["ProfitLossFromOperatingActivities", "OperatingProfitLoss"]);

  const netIncome = toUsd(netIncomeFact);
  const operatingCashFlow = toUsd(operatingCashFact);
  const capex = Math.abs(toUsd(capexFact) ?? 0);
  const freeCashFlow = operatingCashFlow == null ? null : operatingCashFlow - capex;
  const reportedEps = toUsd(epsFact);
  const reportedShares = safeNumber(sharesFact?.val);
  const price = quote.price;
  const shares = quote.marketCap && price
    ? quote.marketCap / price
    : reportedEps > 0 && netIncome != null
      ? netIncome / reportedEps
      : reportedShares;
  const equity = toUsd(equityFact);
  const assets = toUsd(assetsFact);
  const liabilities = toUsd(liabilitiesFact);
  const cash = toUsd(cashFact) ?? 0;
  const shortDebt = Math.max(0, toUsd(shortDebtFact) ?? 0);
  const longDebt = Math.max(0, toUsd(longDebtFact) ?? 0);
  const totalDebt = shortDebt + longDebt;
  const netDebt = totalDebt - cash;
  const currentAssets = toUsd(currentAssetsFact);
  const currentLiabilities = toUsd(currentLiabilitiesFact);
  const interestExpense = Math.abs(toUsd(interestExpenseFact) ?? 0);
  const grossProfit = toUsd(grossProfitFact);
  const operatingIncome = toUsd(operatingIncomeFact);

  const netMargin = revenue && netIncome != null ? netIncome / revenue : null;
  const fcfMargin = revenue && freeCashFlow != null ? freeCashFlow / revenue : null;
  const roe = equity && netIncome != null ? netIncome / equity : null;
  const eps = reportedEps ?? (shares && netIncome != null ? netIncome / shares : null);
  const fcfPerShare = shares && freeCashFlow != null ? freeCashFlow / shares : null;
  const dividendPerShare = toUsd(dividendFact) ?? 0;
  const dividendYield = price ? dividendPerShare / price : null;
  const grossMargin = revenue && grossProfit != null ? grossProfit / revenue : null;
  const operatingMargin = revenue && operatingIncome != null ? operatingIncome / revenue : null;
  const currentRatio = currentAssets && currentLiabilities ? currentAssets / currentLiabilities : null;
  const debtToEquity = equity ? totalDebt / equity : null;
  const netDebtPerShare = shares ? netDebt / shares : null;
  const cashToDebt = totalDebt > 0 ? cash / totalDebt : cash > 0 ? null : 0;
  const fcfToDebt = totalDebt > 0 && freeCashFlow != null ? freeCashFlow / totalDebt : null;
  const interestCoverage = interestExpense > 0 && operatingIncome != null ? operatingIncome / interestExpense : null;
  const payoutRatio = eps > 0 ? dividendPerShare / eps : null;

  const isBank = meta.valuationType === "bank";
  const qualityScore = Math.round(clamp(
    40 +
      clamp(revenueGrowth ?? 0, -0.2, 0.35) * 50 +
      clamp(netMargin ?? 0, -0.2, 0.45) * 60 +
      (isBank ? 0 : clamp(fcfMargin ?? 0, -0.2, 0.45) * 35) +
      clamp(roe ?? 0, -0.3, 0.6) * 12 +
      (isBank ? (netIncome > 0 ? 8 : -10) : (freeCashFlow > 0 ? 6 : -10)),
    0,
    100,
  ));

  const normalizedGrowth = clamp(revenueGrowth ?? 0.04, -0.08, 0.24);
  const valuationEps = quote.forwardEps > 0 ? quote.forwardEps : eps;
  const forwardEpsGrowth = quote.forwardEps > 0 && quote.nextYearEps > 0
    ? quote.nextYearEps / quote.forwardEps - 1
    : null;
  const growthSignals = [
    revenueGrowth == null ? null : { value: clamp(revenueGrowth, -0.12, 0.3), weight: 0.4 },
    forwardEpsGrowth == null ? null : { value: clamp(forwardEpsGrowth, -0.12, 0.3), weight: 0.6 },
  ].filter(Boolean);
  const growthProfile = growthSignals.length
    ? growthSignals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) /
      growthSignals.reduce((sum, signal) => sum + signal.weight, 0)
    : normalizedGrowth;
  const profitabilityPremium = (netMargin ?? 0) >= 0.2
    ? 1.5
    : (netMargin ?? 0) >= 0.1
      ? 0.75
      : (netMargin ?? 0) < 0
        ? -1.5
        : 0;
  const earningsMultiple = clamp(11.5 + growthProfile * 55 + profitabilityPremium, 9, 28);
  const bearMultiple = clamp(earningsMultiple - 5, 8, 22);
  const bullMultiple = clamp(earningsMultiple + 6, 14, 32);
  const fcfMultiple = clamp(earningsMultiple - 2, 8, 26);
  const earningsModelEligible = valuationEps > 0 && (!(price > 0) || price / valuationEps <= 100);
  const earningsValue = earningsModelEligible ? valuationEps * earningsMultiple : null;
  const cashFlowValue = !isBank && fcfPerShare > 0 ? fcfPerShare * fcfMultiple : null;
  const salesMultiple = clamp(2.2 + Math.max(0, normalizedGrowth) * 24, 1.5, 9);
  const salesModelEligible = !isBank && revenue > 0 && shares > 0 && earningsValue == null && cashFlowValue == null;
  const rawSalesValue = salesModelEligible ? (revenue * salesMultiple - netDebt) / shares : null;
  const salesValue = rawSalesValue > 0 ? rawSalesValue : null;
  const relativeValue = earningsValue ?? cashFlowValue ?? salesValue;
  const initialGrowth = clamp((revenueGrowth ?? growthProfile ?? 0.05) * 100, -5, 15);
  const modelRiskPremium = (netMargin ?? 0) < 0 || (!isBank && (freeCashFlow ?? 0) < 0)
    ? 2
    : (netMargin ?? 0) > 0.18 && (isBank || (freeCashFlow ?? 0) > 0) && (revenueGrowth ?? 0) >= 0
      ? -0.5
      : 0;
  const wacc = clamp(8.7 + modelRiskPremium, 7.5, 12.5);
  const terminalGrowth = 2.5;
  const dcfValue = !isBank ? calculateDcfPerShare({
    fcfPerShare,
    growth: initialGrowth,
    wacc,
    terminalGrowth,
    netDebtPerShare: netDebtPerShare ?? 0,
  }) : null;
  let fairValue = null;
  if (earningsValue) {
    fairValue = earningsValue;
  } else if (salesValue) {
    fairValue = salesValue;
  } else if (dcfValue && cashFlowValue) {
    fairValue = clamp(dcfValue * 0.35 + cashFlowValue * 0.65, cashFlowValue * 0.75, cashFlowValue * 1.25);
  } else {
    fairValue = dcfValue ?? cashFlowValue;
  }
  if (fairValue && price && !earningsValue) fairValue = clamp(fairValue, price * 0.35, price * 3);

  const scenarioDcf = {
    bear: !isBank ? calculateDcfPerShare({
      fcfPerShare,
      growth: Math.max(-10, initialGrowth - 4),
      wacc: wacc + 1.5,
      terminalGrowth: Math.max(0.5, terminalGrowth - 0.5),
      netDebtPerShare: netDebtPerShare ?? 0,
    }) : null,
    base: dcfValue,
    bull: !isBank ? calculateDcfPerShare({
      fcfPerShare,
      growth: Math.min(35, initialGrowth + 4),
      wacc: Math.max(6, wacc - 1),
      terminalGrowth: Math.min(4, terminalGrowth + 0.5),
      netDebtPerShare: netDebtPerShare ?? 0,
    }) : null,
  };
  const bearEps = quote.forwardEpsLow > 0 ? quote.forwardEpsLow : valuationEps > 0 ? valuationEps * 0.95 : null;
  const bullEps = quote.forwardEpsHigh > 0 ? quote.forwardEpsHigh : valuationEps > 0 ? valuationEps * 1.05 : null;
  const earningsScenarios = earningsValue ? {
    bear: bearEps * bearMultiple,
    base: earningsValue,
    bull: bullEps * bullMultiple,
  } : null;
  const guardDcfScenario = (scenarioValue, anchor, lowFactor, highFactor) => {
    if (!(anchor > 0)) return scenarioValue ?? null;
    if (!(scenarioValue > 0)) return anchor;
    return clamp(scenarioValue * 0.35 + anchor * 0.65, anchor * lowFactor, anchor * highFactor);
  };
  const scenarios = earningsScenarios ?? (salesValue ? {
    bear: salesValue * 0.65,
    base: fairValue,
    bull: salesValue * 1.4,
  } : {
    bear: guardDcfScenario(scenarioDcf.bear, cashFlowValue, 0.65, 1),
    base: fairValue,
    bull: guardDcfScenario(scenarioDcf.bull, cashFlowValue, 1, 1.45),
  });
  const multiYearYears = earningsValue ? 5 : null;
  const multiYearGrowth = earningsValue
    ? clamp(forwardEpsGrowth ?? revenueGrowth ?? 0.06, 0, 0.15)
    : null;
  const multiYearMultiple = earningsValue ? clamp(earningsMultiple + 4, 14, 26) : null;
  const multiYearBullTarget = earningsValue
    ? valuationEps * ((1 + multiYearGrowth) ** multiYearYears) * multiYearMultiple
    : null;
  const scenarioInputs = earningsValue ? {
    eps: valuationEps,
    epsSource: quote.forwardEps > 0 ? "Nasdaq 分析师一致预期" : "最近年度 GAAP EPS",
    epsYear: quote.forwardEpsYear ?? revenueSeries.at(-1)?.end ?? netIncomeFact?.end ?? null,
    epsLow: bearEps,
    epsHigh: bullEps,
    estimates: quote.forwardEpsEstimates ?? null,
    nextYearEps: quote.nextYearEps ?? null,
    nextYearEpsYear: quote.nextYearEpsYear ?? null,
    forwardEpsGrowth: forwardEpsGrowth == null ? null : forwardEpsGrowth * 100,
    growthProfile: growthProfile * 100,
    bearMultiple,
    baseMultiple: earningsMultiple,
    bullMultiple,
    multiYearYears,
    multiYearGrowth: multiYearGrowth * 100,
    multiYearMultiple,
    multiYearBullTarget,
  } : null;
  const sensitivityGrowth = [-4, -2, 0, 2, 4].map((offset) => clamp(initialGrowth + offset, -10, 35));
  const sensitivityWacc = [-2, -1, 0, 1, 2].map((offset) => clamp(wacc + offset, 6, 15));
  const sensitivity = sensitivityWacc.map((rate) => ({
    wacc: rate,
    values: sensitivityGrowth.map((growth) => calculateDcfPerShare({
      fcfPerShare,
      growth,
      wacc: rate,
      terminalGrowth,
      netDebtPerShare: netDebtPerShare ?? 0,
    })),
  }));
  const impliedGrowth = !isBank ? solveImpliedGrowth({
    price,
    fcfPerShare,
    wacc,
    terminalGrowth,
    netDebtPerShare: netDebtPerShare ?? 0,
  }) : null;

  const cyclical = adjustCyclicalValuation({
    symbol: meta.symbol,
    sector: quote.sector ?? meta.sector,
    company: companyFacts.entityName,
    ttmEps: eps,
    forwardEps: quote.forwardEps,
    earningsMultiple,
    dcfValue,
    fairValue,
  });
  if (cyclical.kind || cyclical.dcfWeight) {
    fairValue = cyclical.fairValue;
    earningsMultiple = cyclical.earningsMultiple;
  }
  const marginOfSafety = fairValue && price ? (fairValue / price - 1) * 100 : null;
  const anomaly = anomalyFromMargin(marginOfSafety);
  const valuationScore = anomaly.modelAnomaly || marginOfSafety == null ? null : clamp(52 + marginOfSafety * 0.85, 0, 100);
  const opportunityScore = anomaly.modelAnomaly
    ? null
    : Math.round(clamp(qualityScore * 0.64 + (valuationScore ?? 50) * 0.36, 0, 100));
  const priceConflict = price > 0 ? rememberTape(meta.symbol, { last: price, source: quote.source || "screener-quote" }) : null;
  const dailyChange = price && quote.previousClose ? (price / quote.previousClose - 1) * 100 : null;
  const drawdown30d = price && quote.thirtyDayHigh ? (price / quote.thirtyDayHigh - 1) * 100 : null;
  const marketCap = quote.marketCap ?? (shares && price ? shares * price : null);

  let status = "Model unavailable";
  let modelStatusReason = null;
  if (anomaly.modelAnomaly) {
    status = anomaly.status;
    modelStatusReason = anomaly.modelStatusReason;
  } else if (marginOfSafety != null) {
    if (marginOfSafety >= 25) status = "Strongly Undervalued";
    else if (marginOfSafety >= 10) status = "Undervalued";
    else if (marginOfSafety >= -8) status = "Near Fair Value";
    else status = "Above Fair Value";
    if (salesValue && !dcfValue) modelStatusReason = "成长型 EV/Sales 情景估值";
  } else if (revenue == null && eps == null && fcfPerShare == null) {
    status = "Financial facts unavailable";
    modelStatusReason = "缺少可比年度营收、盈利与现金流";
  } else if ((eps ?? 0) <= 0 && (fcfPerShare ?? 0) <= 0 && !(revenue > 0)) {
    status = "Pre-revenue model unavailable";
    modelStatusReason = "负盈利、负现金流且缺少有效营收";
  } else if (salesModelEligible && !(rawSalesValue > 0)) {
    status = "Sales value below net debt";
    modelStatusReason = "营收倍数估值不足以覆盖净负债";
  } else {
    status = "Model unavailable";
    modelStatusReason = "现有财务事实不足以支持可靠估值";
  }

  let risk = "Medium";
  if ((netMargin ?? 0) < 0 || (!isBank && (freeCashFlow ?? 0) < 0)) risk = "High";
  else if ((netMargin ?? 0) > 0.18 && (isBank || (freeCashFlow ?? 0) > 0) && (revenueGrowth ?? 0) >= 0) risk = "Low";

  const catalyst = revenueGrowth > 0.18
    ? "Growth acceleration"
    : drawdown30d < -8
      ? "Valuation reset"
      : freeCashFlow > 0
        ? "Cash-flow durability"
        : "Earnings normalization";

  const fiscalDate = [netIncomeFact?.end, operatingCashFact?.end, revenueSeries.at(-1)?.end]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const fundamentalState = fundamentalsStale({ fiscalDate, earningsDate: quote.earningsDate });

  const toPeriodMap = (series) => new Map(series.map((point) => [point.end, point.__unit === "shares" ? factValue(point) : toUsd(point)]));
  const historyMaps = {
    revenue: toPeriodMap(revenueHistory),
    netIncome: toPeriodMap(netIncomeHistory),
    operatingCashFlow: toPeriodMap(operatingCashHistory),
    capex: toPeriodMap(capexHistory),
    eps: toPeriodMap(epsHistory),
    shares: toPeriodMap(shareHistory),
    grossProfit: toPeriodMap(grossProfitHistory),
    operatingIncome: toPeriodMap(operatingIncomeHistory),
  };
  const historyPeriods = [...new Set([
    ...historyMaps.revenue.keys(),
    ...historyMaps.netIncome.keys(),
    ...historyMaps.operatingCashFlow.keys(),
  ])].sort().slice(-6);
  const financialHistory = historyPeriods.map((period) => {
    const historicalOperatingCash = historyMaps.operatingCashFlow.get(period);
    const historicalCapex = Math.abs(historyMaps.capex.get(period) ?? 0);
    return {
      period,
      revenue: historyMaps.revenue.get(period) ?? null,
      grossProfit: historyMaps.grossProfit.get(period) ?? null,
      operatingIncome: historyMaps.operatingIncome.get(period) ?? null,
      netIncome: historyMaps.netIncome.get(period) ?? null,
      operatingCashFlow: historicalOperatingCash ?? null,
      capex: historyMaps.capex.get(period) ?? null,
      freeCashFlow: historicalOperatingCash == null ? null : historicalOperatingCash - historicalCapex,
      eps: historyMaps.eps.get(period) ?? null,
      shares: historyMaps.shares.get(period) ?? null,
    };
  });

  const multiples = {
    pe: eps > 0 && price ? price / eps : null,
    forwardPe: valuationEps > 0 && price ? price / valuationEps : null,
    pb: equity > 0 && marketCap ? marketCap / equity : null,
    ps: revenue > 0 && marketCap ? marketCap / revenue : null,
    pfcf: freeCashFlow > 0 && marketCap ? marketCap / freeCashFlow : null,
    earningsMultiple,
    fcfMultiple,
    earningsAnchor: earningsValue,
    cashFlowAnchor: cashFlowValue,
    salesMultiple,
    salesAnchor: salesValue,
  };

  return {
    sourceOrder: meta.sourceOrder,
    symbol: meta.symbol,
    company: companyFacts.entityName ?? meta.symbol,
    sector: quote.sector ?? meta.sector ?? "Unclassified",
    reportingCurrency,
    usdFxRate: fxRate,
    price,
    previousClose: quote.previousClose,
    dailyChange,
    fairValue,
    opportunityScore,
    qualityScore,
    marginOfSafety,
    modelAnomaly: anomaly.modelAnomaly,
    cyclicalKind: cyclical.kind,
    cyclicalNotes: cyclical.notes,
    fwdToTtm: cyclical.fwdToTtm,
    dcfWeight: cyclical.dcfWeight,
    priceConflict,
    fundamentalsStale: fundamentalState.stale,
    fundamentalsAgeDays: fundamentalState.ageDays,
    fundamentalsStaleReasons: fundamentalState.reasons,
    earningsDate: quote.earningsDate || null,
    status,
    modelStatusReason,
    risk,
    catalyst,
    revenue,
    revenueGrowth: revenueGrowth == null ? null : revenueGrowth * 100,
    netMargin: netMargin == null ? null : netMargin * 100,
    fcfMargin: fcfMargin == null ? null : fcfMargin * 100,
    freeCashFlow,
    earningsValue,
    cashFlowValue,
    salesValue,
    dcfValue,
    relativeValue,
    dividendYield: dividendYield == null ? null : dividendYield * 100,
    annualDividend: dividendPerShare,
    payoutRatio: payoutRatio == null ? null : payoutRatio * 100,
    marketCap,
    eps,
    forwardEps: quote.forwardEps ?? null,
    forwardEpsLow: quote.forwardEpsLow ?? null,
    forwardEpsHigh: quote.forwardEpsHigh ?? null,
    forwardEpsYear: quote.forwardEpsYear ?? null,
    forwardEpsEstimates: quote.forwardEpsEstimates ?? null,
    nextYearEps: quote.nextYearEps ?? null,
    nextYearEpsYear: quote.nextYearEpsYear ?? null,
    fcfPerShare,
    roe: roe == null ? null : roe * 100,
    grossMargin: grossMargin == null ? null : grossMargin * 100,
    operatingMargin: operatingMargin == null ? null : operatingMargin * 100,
    currentRatio,
    debtToEquity,
    netDebtPerShare,
    cashToDebt,
    fcfToDebt,
    interestCoverage,
    assets,
    liabilities,
    cash,
    totalDebt,
    equity,
    financialHistory,
    multiples,
    valuationModel: {
      model: isBank
        ? "前瞻 EPS 情景估值 + 账面价值复核"
        : earningsValue
          ? "前瞻 EPS 情景估值 + DCF 交叉验证"
          : salesValue
            ? "成长型 EV/Sales 情景模型"
            : "自由现金流锚点 + 受限 DCF",
      weights: earningsValue
        ? { earnings: 100 - (cyclical.dcfWeight || 0), dcf: cyclical.dcfWeight || 0, relative: 0 }
        : salesValue
          ? { sales: 100, dcf: 0, relative: 0 }
          : { cashFlow: cashFlowValue ? 65 : 0, dcf: dcfValue && cashFlowValue ? 35 : dcfValue ? 100 : 0 },
      assumptions: { growth: initialGrowth, wacc, terminalGrowth, forecastYears: 5 },
      scenarios,
      scenarioInputs,
      sensitivity: { growth: sensitivityGrowth, rows: sensitivity },
      impliedGrowth,
      note: isBank
        ? "银行以可解释的前瞻盈利倍数作为今日价值锚点，账面价值仅用于风险复核。"
        : earningsValue
          ? `今日合理价值使用 ${valuationEps.toFixed(2)} 美元前瞻 EPS × ${earningsMultiple.toFixed(1)} 倍基准市盈率；DCF 只作交叉验证，不进入基准值。`
          : salesValue
          ? `公司尚未形成正盈利或正自由现金流，基准值采用增长调整后的 ${salesMultiple.toFixed(1)}× EV/Sales，并用悲观/乐观倍数展示不确定性。`
          : "缺少正的盈利预期时，以自由现金流倍数为主，并把 DCF 限制在现金流锚点附近，避免终值主导结果。",
    },
    drawdown30d,
    fiscalDate,
    marketDate: quote.marketDate,
    quoteSource: quote.source,
    secUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${meta.cik}.json`,
    confidence: cyclical.confidence || (anomaly.modelAnomaly ? "Low" : earningsValue && cashFlowValue ? "High" : earningsValue || cashFlowValue ? "Medium" : salesValue ? "Low" : "Low"),
  };
}

function buildQuoteOnly(meta, quote, reason = "SEC filing facts unavailable") {
  const dailyChange = quote.price && quote.previousClose ? (quote.price / quote.previousClose - 1) * 100 : null;
  return {
    sourceOrder: meta.sourceOrder,
    symbol: meta.symbol,
    company: meta.company ?? meta.symbol,
    sector: quote.sector ?? "Unclassified",
    price: quote.price,
    previousClose: quote.previousClose,
    dailyChange,
    fairValue: null,
    opportunityScore: null,
    qualityScore: null,
    marginOfSafety: null,
    status: reason === "No matching SEC filer was found for this symbol" ? "SEC filer unavailable" : "Financial facts unavailable",
    modelStatusReason: reason === "No matching SEC filer was found for this symbol" ? "未找到匹配的 SEC 申报主体" : "SEC 财务数据获取失败或暂不可用",
    risk: "Unrated",
    catalyst: reason,
    revenueGrowth: null,
    netMargin: null,
    fcfMargin: null,
    freeCashFlow: null,
    earningsValue: null,
    cashFlowValue: null,
    dividendYield: null,
    marketCap: quote.marketCap,
    drawdown30d: null,
    fiscalDate: null,
    marketDate: quote.marketDate,
    quoteSource: quote.source,
    secUrl: meta.cik ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${meta.cik}.json` : null,
    confidence: "Low",
    modelNote: reason,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getStockData(meta, force = false) {
  const key = meta.symbol;
  const now = Date.now();
  const cached = stockDataCache.get(key);
  if (!force && cached?.stock && cached.expiresAt > now) return { ...cached.stock, sourceOrder: meta.sourceOrder };
  if (!force && cached?.pending) return cached.pending.then((stock) => ({ ...stock, sourceOrder: meta.sourceOrder }));
  const entry = cached ?? {};
  entry.pending = (async () => {
    const quote = await fetchQuote(meta.symbol);
    if (!meta.cik) return buildQuoteOnly(meta, quote, "No matching SEC filer was found for this symbol");
    try {
      const facts = await fetchCompanyFacts(meta.cik);
      return await buildValuation(meta, quote, facts);
    } catch {
      return buildQuoteOnly(meta, quote);
    }
  })().then((stock) => {
    entry.stock = stock;
    entry.expiresAt = Date.now() + 30 * 60 * 1000;
    return stock;
  }).finally(() => {
    entry.pending = null;
  });
  stockDataCache.set(key, entry);
  return entry.pending.then((stock) => ({ ...stock, sourceOrder: meta.sourceOrder }));
}

async function getFullWatchlistStocks(watchlist, universe, force, errors) {
  const cached = fullWatchlistCache.get(watchlist.id);
  const signature = `${watchlist.modifiedAt ?? watchlist.updated ?? "unknown"}:${watchlist.symbols.join(",")}`;
  if (!force && cached?.signature === signature && cached?.stocks && cached.expiresAt > Date.now()) return cached.stocks;
  if (!force && cached?.signature === signature && cached?.pending) return cached.pending;
  const entry = cached ?? {};
  entry.signature = signature;
  entry.pending = mapWithConcurrency(universe, 6, async (meta) => {
    try {
      return await getStockData(meta, force);
    } catch (error) {
      errors.push(`${meta.symbol} quote: ${error.message}`);
      return null;
    }
  }).then((stocks) => {
    entry.stocks = stocks.filter(Boolean);
    entry.signature = signature;
    entry.expiresAt = Date.now() + 30 * 60 * 1000;
    return entry.stocks;
  }).finally(() => {
    entry.pending = null;
  });
  fullWatchlistCache.set(watchlist.id, entry);
  return entry.pending;
}

async function loadMarketData({ watchlistId, page, pageSize, presetId = "all" }, force = false) {
  const errors = [];
  const watchlists = await loadWatchlists();
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === watchlistId) ?? watchlists[0];
  let tickerLookup = new Map();
  try {
    tickerLookup = await getCompanyTickerLookup();
  } catch (error) {
    errors.push(`SEC ticker map: ${error.message}`);
  }
  const fallbackLookup = new Map(FALLBACK_UNIVERSE.map((stock) => [stock.symbol, stock]));
  const universe = activeWatchlist.symbols.map((symbol, index) => {
    const company = tickerLookup.get(symbol);
    const fallback = fallbackLookup.get(symbol);
    return {
      symbol,
      cik: company?.cik ?? fallback?.cik ?? null,
      company: company?.company ?? symbol,
      sector: fallback?.sector ?? null,
      valuationType: symbol === "JPM" ? "bank" : fallback?.valuationType,
      sourceOrder: index + 1,
    };
  });
  let totalResults = activeWatchlist.total;
  let totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  let currentPage = clamp(page, 1, totalPages);
  let startIndex = (currentPage - 1) * pageSize;
  let validStocks = [];

  if (presetId === "all") {
    const pageUniverse = universe.slice(startIndex, startIndex + pageSize);
    const stocks = await mapWithConcurrency(pageUniverse, 4, async (meta) => {
      try {
        return await getStockData(meta, force);
      } catch (error) {
        errors.push(`${meta.symbol} quote: ${error.message}`);
        return null;
      }
    });
    validStocks = stocks.filter(Boolean);
  } else {
    const fullStocks = await getFullWatchlistStocks(activeWatchlist, universe, force, errors);
    const filteredStocks = fullStocks.filter((stock) => matchesPreset(stock, presetId));
    totalResults = filteredStocks.length;
    totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
    currentPage = clamp(page, 1, totalPages);
    startIndex = (currentPage - 1) * pageSize;
    validStocks = filteredStocks.slice(startIndex, startIndex + pageSize);
  }

  if (!validStocks.length && totalResults > 0 && errors.length) {
    throw new Error(errors.join("; ") || "No market data was returned");
  }

  const marketDates = validStocks.map((stock) => stock.marketDate).filter(Boolean).sort();
  const fiscalDates = validStocks.map((stock) => stock.fiscalDate).filter(Boolean).sort();
  return {
    stocks: validStocks,
    generatedAt: new Date().toISOString(),
    listNote: activeWatchlist.note || null,
    fallback: activeWatchlist.fallback || null,
    listSource: activeWatchlist.fallback ? "public-demo" : "vault",
    listDir: WATCHLIST_DIR,
    dedupedSymbolCount: new Set(watchlists.flatMap((row) => row.symbols)).size,
    mentionCount: watchlists.reduce((sum, row) => sum + (row.total || 0), 0),
    watchlists: watchlists.map((watchlist) => ({
      id: watchlist.id,
      title: watchlist.title,
      total: watchlist.total,
      updated: watchlist.updated,
      filename: watchlist.filename,
      symbols: watchlist.symbols,
      note: watchlist.note || null,
      fallback: watchlist.fallback || null,
    })),
    activeWatchlist: {
      id: activeWatchlist.id,
      title: activeWatchlist.title,
      total: activeWatchlist.total,
      updated: activeWatchlist.updated,
      filename: activeWatchlist.filename,
      sourcePath: activeWatchlist.filePath,
      note: activeWatchlist.note || null,
      fallback: activeWatchlist.fallback || null,
    },
    pagination: {
      page: currentPage,
      pageSize,
      total: totalResults,
      totalPages,
      start: totalResults ? startIndex + 1 : 0,
      end: Math.min(startIndex + pageSize, totalResults),
    },
    screening: {
      presetId,
      scope: presetId === "all" ? "current-page" : "full-watchlist",
      sourceTotal: activeWatchlist.total,
      totalMatches: totalResults,
    },
    marketDataAsOf: marketDates.at(-1) ?? null,
    fundamentalsAsOf: fiscalDates.at(-1) ?? null,
    fundamentalsStale: validStocks.some((stock) => stock.fundamentalsStale),
    staleNote: validStocks.some((stock) => stock.fundamentalsStale)
      ? "财务截止日超过 30 天，或已经过了财报日但仍在用更早的报表。"
      : null,
    partial: errors.length > 0,
    errors,
    sources: [
      { name: "SEC EDGAR 公司财务数据", url: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces" },
      { name: "Nasdaq 公开行情", url: "https://www.nasdaq.com/market-activity/stocks" },
    ],
    methodology: "有一致盈利预期的公司使用透明的 Bear / Base / Bull 前瞻 EPS 倍数情景；DCF 仅作交叉验证。未盈利成长公司使用 EV/Sales 情景，长期牛市目标与今日合理价值分开显示。",
    disclaimer: "模型估值仅供研究，不构成投资建议。",
  };
}

async function getPayload(params, force = false) {
  const now = Date.now();
  const key = `${params.watchlistId || "default"}:${params.presetId || "all"}:${params.page}:${params.pageSize}`;
  const cached = responseCache.get(key);
  if (!force && cached?.payload && cached.expiresAt > now) return { ...cached.payload, cache: "hit" };
  if (cached?.pending) return cached.pending;
  const entry = cached ?? {};
  entry.pending = loadMarketData(params, force)
    .then((payload) => {
      entry.payload = payload;
      entry.expiresAt = Date.now() + 30 * 60 * 1000;
      return { ...payload, cache: "miss" };
    })
    .finally(() => {
      entry.pending = null;
    });
  responseCache.set(key, entry);
  return entry.pending;
}

export function createMarketApiHandler() {
  return async function marketApiHandler(request, response, next) {
    if (!request.url?.startsWith("/api/stocks")) return next();
    try {
      const url = new URL(request.url, "http://localhost");
      const page = clamp(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1, 1000);
      const pageSize = clamp(Number.parseInt(url.searchParams.get("pageSize") ?? "12", 10) || 12, 5, 25);
      const market = url.searchParams.get("market") === "cn" ? "cn" : "us";
      const params = {
        watchlistId: url.searchParams.get("watchlist") ?? (market === "cn" ? "cn-self" : "kawaii-curated"),
        presetId: url.searchParams.get("preset") ?? "all",
        page,
        pageSize,
      };
      const payload = market === "cn"
        ? await getChinaPayload(params, url.searchParams.get("refresh") === "1")
        : await getPayload(params, url.searchParams.get("refresh") === "1");
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 502;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "Unable to load public market data", detail: error.message }));
    }
  };
}
