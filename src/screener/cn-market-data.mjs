import fs from "node:fs/promises";
import path from "node:path";
import { OBSIDIAN_CN_LISTS } from "../paths.js";

const CN_LIST_DIR = process.env.CN_LIST_DIR || OBSIDIAN_CN_LISTS;
const responseCache = new Map();
const stockCache = new Map();
const fullListCache = new Map();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numberOrNull = (value) => {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number) ? null : number;
};

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

function exchangeForCode(code) {
  if (/^(6|68)/.test(code)) return { suffix: "SH", secid: `1.${code}`, label: "上交所" };
  if (/^(0|3)/.test(code)) return { suffix: "SZ", secid: `0.${code}`, label: "深交所" };
  return { suffix: "BJ", secid: `0.${code}`, label: "北交所" };
}

function listId(filename) {
  if (filename.startsWith("自选")) return "cn-self";
  if (filename.startsWith("孟总")) return "cn-meng";
  return `cn-${filename.replace(/\.md$/i, "").replace(/\s+/g, "-").toLowerCase()}`;
}

export async function loadChinaWatchlists() {
  const entries = await fs.readdir(CN_LIST_DIR, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const lists = [];
  for (const file of files) {
    const filePath = path.join(CN_LIST_DIR, file.name);
    const [content, stats] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.name.replace(/\.md$/i, "");
    const stocks = [];
    const seen = new Set();
    for (const match of content.matchAll(/^\|\s*(\d{6})\s*\|\s*([^|]+?)\s*\|/gm)) {
      const symbol = match[1];
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      stocks.push({ symbol, company: match[2].trim() });
    }
    lists.push({
      id: listId(file.name),
      title,
      filename: file.name,
      filePath,
      updated: stats.mtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      stocks,
      symbols: stocks.map((stock) => stock.symbol),
      total: stocks.length,
    });
  }
  return lists.sort((a, b) => (a.id === "cn-self" ? -1 : b.id === "cn-self" ? 1 : a.title.localeCompare(b.title, "zh-CN")));
}

function unavailableQuote(meta) {
  return {
    symbol: meta.symbol,
    company: meta.company,
    exchange: exchangeForCode(meta.symbol),
    price: null,
    previousClose: null,
    high: null,
    low: null,
    open: null,
    dailyChange: null,
    marketCap: null,
    floatMarketCap: null,
    pe: null,
    pb: null,
    turnover: null,
    marketDate: null,
  };
}

export async function fetchChinaQuotes(metas) {
  if (!metas.length) return new Map();
  const fields = "f2,f3,f8,f9,f12,f14,f15,f16,f17,f18,f20,f21,f23,f124";
  const secids = metas.map((meta) => exchangeForCode(meta.symbol).secid).join(",");
  const hosts = [
    "https://push2.eastmoney.com/api/qt/ulist.np/get",
    "https://82.push2.eastmoney.com/api/qt/ulist.np/get",
    "https://push2delay.eastmoney.com/api/qt/ulist.np/get",
  ];
  let payload = null;
  let lastError = null;
  for (const host of hosts) {
    try {
      payload = await fetchJson(`${host}?fltt=2&invt=2&fields=${fields}&secids=${secids}`, {
        headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
      }, 20000);
      if (payload?.data?.diff) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!payload?.data?.diff) {
    if (lastError) throw lastError;
    return new Map();
  }
  const quotes = new Map();
  for (const data of payload?.data?.diff ?? []) {
    const code = String(data.f12 ?? "");
    if (!code) continue;
    quotes.set(code, {
      symbol: code,
      company: data.f14,
      exchange: exchangeForCode(code),
      price: numberOrNull(data.f2),
      previousClose: numberOrNull(data.f18),
      high: numberOrNull(data.f15),
      low: numberOrNull(data.f16),
      open: numberOrNull(data.f17),
      dailyChange: numberOrNull(data.f3),
      marketCap: numberOrNull(data.f20),
      floatMarketCap: numberOrNull(data.f21),
      pe: numberOrNull(data.f9),
      pb: numberOrNull(data.f23),
      turnover: numberOrNull(data.f8),
      marketDate: numberOrNull(data.f124) ? new Date(data.f124 * 1000).toISOString() : null,
    });
  }
  return quotes;
}

async function fetchChinaFinancials(code) {
  const exchange = exchangeForCode(code);
  const secuCode = `${code}.${exchange.suffix}`;
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_F10_FINANCE_MAINFINADATA");
  url.searchParams.set("columns", "ALL");
  url.searchParams.set("filter", `(SECUCODE=\"${secuCode}\")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "24");
  url.searchParams.set("sortTypes", "-1");
  url.searchParams.set("sortColumns", "REPORT_DATE");
  const payload = await fetchJson(url, {
    headers: { Referer: "https://emweb.securities.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
  }, 30000);
  return payload?.result?.data ?? [];
}

async function fetchChinaForecasts(metas) {
  if (!metas.length) return new Map();
  const codes = metas.map((meta) => `"${meta.symbol}"`).join(",");
  const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_WEB_RESPREDICT");
  url.searchParams.set("columns", "WEB_RESPREDICT");
  url.searchParams.set("filter", `(SECURITY_CODE in (${codes}))`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", String(Math.max(50, metas.length)));
  url.searchParams.set("sortTypes", "-1");
  url.searchParams.set("sortColumns", "RATING_ORG_NUM");
  const payload = await fetchJson(url, {
    headers: { Referer: "https://data.eastmoney.com/report/profitforecast.jshtml", "User-Agent": "Mozilla/5.0" },
  });
  return new Map((payload?.result?.data ?? []).map((row) => [String(row.SECURITY_CODE), row]));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchChinaValuationHistory(metas) {
  if (!metas.length) return new Map();
  const codes = metas.map((meta) => `"${meta.symbol}"`).join(",");
  const startDate = new Date(Date.now() - 3 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_VALUEANALYSIS_DET");
  url.searchParams.set("columns", "SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ,PS_TTM,BOARD_CODE,BOARD_NAME");
  url.searchParams.set("filter", `(SECURITY_CODE in (${codes}))(TRADE_DATE>='${startDate}')`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", String(Math.max(10000, metas.length * 800)));
  url.searchParams.set("sortTypes", "-1");
  url.searchParams.set("sortColumns", "TRADE_DATE");
  url.searchParams.set("source", "WEB");
  url.searchParams.set("client", "WEB");
  const payload = await fetchJson(url, {
    headers: { Referer: "https://data.eastmoney.com/gzfx/", "User-Agent": "Mozilla/5.0" },
  }, 45000);
  const groups = new Map();
  for (const row of payload?.result?.data ?? []) {
    const code = String(row.SECURITY_CODE ?? "");
    if (!groups.has(code)) groups.set(code, { pe: [], pb: [], industry: row.BOARD_NAME ?? null });
    const group = groups.get(code);
    const pe = numberOrNull(row.PE_TTM);
    const pb = numberOrNull(row.PB_MRQ);
    if (pe >= 5 && pe <= 150) group.pe.push(pe);
    if (pb >= 0.2 && pb <= 50) group.pb.push(pb);
    if (!group.industry && row.BOARD_NAME) group.industry = row.BOARD_NAME;
  }
  return new Map([...groups.entries()].map(([code, group]) => [code, {
    historicalPe: median(group.pe),
    historicalPb: median(group.pb),
    historySamples: group.pe.length,
    industry: group.industry,
  }]));
}

function matchesPreset(stock, presetId) {
  const rules = {
    all: () => true,
    undervalued: (item) => item.marginOfSafety > 0,
    "high-safety": (item) => item.marginOfSafety >= 20,
    "positive-fcf": (item) => item.operatingCashFlow > 0 && item.marginOfSafety > 0,
    "quality-value": (item) => item.qualityScore >= 65 && item.marginOfSafety >= 5,
    dividend: (item) => item.dividendYield > 0 && item.marginOfSafety > 0,
    "large-cap": (item) => item.marketCap >= 100_000_000_000 && item.marginOfSafety > 0,
    quality: (item) => item.qualityScore >= 68 && item.operatingCashFlow > 0,
    capitulation: (item) => item.qualityScore >= 65 && item.dailyChange <= -3,
  };
  return (rules[presetId] ?? rules.all)(stock);
}

function buildChinaStock(meta, quote, rows, forecast = null, valuationHistory = null) {
  const annualRows = rows.filter((row) => String(row.REPORT_TYPE).includes("年报")).slice(0, 6);
  const annual = annualRows[0] ?? null;
  const latest = rows[0] ?? annual;
  const eps = numberOrNull(annual?.EPSJB);
  const revenue = numberOrNull(annual?.TOTALOPERATEREVE);
  const revenueGrowth = numberOrNull(annual?.TOTALOPERATEREVETZ);
  const netIncome = numberOrNull(annual?.PARENTNETPROFIT);
  const profitGrowth = numberOrNull(annual?.PARENTNETPROFITTZ);
  const netMargin = numberOrNull(annual?.XSJLL);
  const grossMargin = numberOrNull(annual?.XSMLL);
  const roe = numberOrNull(annual?.ROEJQ);
  const debtRatio = numberOrNull(annual?.ZCFZL);
  const bookValuePerShare = numberOrNull(annual?.BPS);
  const operatingCashPerShare = numberOrNull(annual?.MGJYXJJE);
  const shares = numberOrNull(annual?.TOTAL_SHARE);
  const operatingCashFlow = operatingCashPerShare != null && shares ? operatingCashPerShare * shares : null;
  const price = quote.price;
  const forecastCount = numberOrNull(forecast?.RATING_ORG_NUM) ?? 0;
  const forwardEps = numberOrNull(forecast?.EPS2);
  const nextForwardEps = numberOrNull(forecast?.EPS3);
  const forecastGrowth = forwardEps > 0 && nextForwardEps > 0 ? (nextForwardEps / forwardEps - 1) * 100 : null;
  const forecastToAnnual = eps > 0 && forwardEps > 0 ? forwardEps / eps : null;
  const reliableForecast = forwardEps > 0 && (
    forecastCount >= 3 ||
    (forecastCount >= 1 && forecastToAnnual >= 0.6 && forecastToAnnual <= 2.5)
  );
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const yearStart = Date.UTC(currentYear, 0, 1);
  const nextYearStart = Date.UTC(currentYear + 1, 0, 1);
  const yearProgress = clamp((now.getTime() - yearStart) / (nextYearStart - yearStart), 0, 1);
  const ntmEps = reliableForecast && nextForwardEps > 0 && Number(forecast?.YEAR2) === currentYear
    ? forwardEps * (1 - yearProgress) + nextForwardEps * yearProgress
    : forwardEps;
  const valuationEps = reliableForecast ? ntmEps : eps;
  const valuationYear = reliableForecast ? "未来12个月" : annual?.REPORT_DATE_NAME ?? annual?.REPORT_DATE;
  const sourceLabel = reliableForecast ? `东方财富 ${forecast?.YEAR2 ?? "当年"}/${forecast?.YEAR3 ?? "次年"} 盈利预测加权（${forecastCount} 家机构）` : "东方财富最近完整年报";
  const sourceType = reliableForecast ? "forecast" : "annual-anchor";
  const growthProfile = reliableForecast
    ? clamp((revenueGrowth ?? 0) * 0.3 + (forecastGrowth ?? 0) * 0.7, -10, 30)
    : clamp((revenueGrowth ?? 0) * 0.4 + (profitGrowth ?? 0) * 0.6, -10, 25);
  const roePremium = roe >= 18 ? 2.5 : roe >= 12 ? 1.5 : roe >= 8 ? 0.5 : roe < 5 ? -1 : 0;
  const balancePremium = debtRatio != null && debtRatio < 35 ? 0.5 : debtRatio > 70 ? -1.5 : 0;
  const growthForPe = clamp(growthProfile, -10, 50);
  const scaledRoePremium = reliableForecast && growthForPe < 10 ? roePremium * Math.max(0, growthForPe / 10) : roePremium;
  const justifiedMultiple = reliableForecast
    ? clamp(12 + Math.max(0, growthForPe) * 0.45 + scaledRoePremium + balancePremium, 10, 38)
    : clamp(10 + Math.max(0, growthForPe) * 0.34 + roePremium + balancePremium, 8, 22);
  const historicalMultiple = numberOrNull(valuationHistory?.historicalPe);
  const baseMultiple = reliableForecast && historicalMultiple
    ? clamp(justifiedMultiple * 0.65 + clamp(historicalMultiple, 8, 60) * 0.35, 10, 45)
    : justifiedMultiple;
  const bearMultiple = clamp(baseMultiple - (reliableForecast ? 7 : 4), 7, 35);
  const bullMultiple = clamp(baseMultiple + (reliableForecast ? 8 : 5), 13, 55);
  const fairValue = valuationEps > 0 ? valuationEps * baseMultiple : null;
  const bearEps = reliableForecast ? Math.max(eps > 0 ? eps : 0, valuationEps * 0.78) : valuationEps;
  const bullEps = reliableForecast ? valuationEps * 1.12 : valuationEps;
  const scenarios = valuationEps > 0 ? {
    bear: bearEps * bearMultiple,
    base: fairValue,
    bull: bullEps * bullMultiple,
  } : { bear: null, base: null, bull: null };
  const longTermGrowth = clamp(growthProfile, 0, 15) / 100;
  const multiYearBullTarget = valuationEps > 0 ? valuationEps * ((1 + longTermGrowth) ** 5) * clamp(baseMultiple + 3, 12, 27) : null;
  const marginOfSafety = reliableForecast && fairValue && price ? (fairValue / price - 1) * 100 : null;
  const qualityScore = Math.round(clamp(
    38 + clamp(roe ?? 0, -10, 30) * 1.45 + clamp(netMargin ?? 0, -15, 30) * 0.55 +
    clamp(revenueGrowth ?? 0, -30, 40) * 0.25 + clamp(profitGrowth ?? 0, -40, 60) * 0.2 -
    Math.max(0, (debtRatio ?? 45) - 55) * 0.45 + (operatingCashFlow > 0 ? 7 : -7),
    0,
    100,
  ));
  const valuationScore = marginOfSafety == null ? 45 : clamp(50 + marginOfSafety * 0.75, 0, 100);
  const opportunityScore = Math.round(clamp(qualityScore * 0.62 + valuationScore * 0.38, 0, 100));
  let status = "Model unavailable";
  let modelStatusReason = null;
  if (!reliableForecast && fairValue) {
    status = "Historical Anchor";
    modelStatusReason = "缺少足够可靠的前瞻盈利样本，仅展示最近年报盈利锚";
  } else if (marginOfSafety != null) {
    if (marginOfSafety >= 25) status = "Strongly Undervalued";
    else if (marginOfSafety >= 10) status = "Undervalued";
    else if (marginOfSafety >= -20) status = "Near Fair Value";
    else status = "Above Fair Value";
  } else {
    modelStatusReason = eps == null ? "最近年报与公开盈利预测均缺少可用 EPS" : "最近年报 EPS 为负，且公开预测样本不足以形成可靠估值";
  }
  const risk = eps <= 0 || (debtRatio ?? 0) > 70 ? "High" : qualityScore >= 72 && (debtRatio ?? 100) < 55 ? "Low" : "Medium";
  const financialHistory = [...annualRows].reverse().map((row) => {
    const rowShares = numberOrNull(row.TOTAL_SHARE);
    const cashPerShare = numberOrNull(row.MGJYXJJE);
    return {
      period: String(row.REPORT_DATE).slice(0, 10),
      revenue: numberOrNull(row.TOTALOPERATEREVE),
      grossProfit: numberOrNull(row.MLR),
      operatingIncome: numberOrNull(row.OPERATE_PROFIT_PK),
      netIncome: numberOrNull(row.PARENTNETPROFIT),
      operatingCashFlow: rowShares && cashPerShare != null ? rowShares * cashPerShare : null,
      capex: null,
      freeCashFlow: null,
      eps: numberOrNull(row.EPSJB),
      shares: rowShares,
    };
  });
  return {
    market: "cn",
    currency: "CNY",
    sourceOrder: meta.sourceOrder,
    symbol: meta.symbol,
    company: quote.company ?? meta.company,
    sector: valuationHistory?.industry ?? forecast?.INDUSTRY_BOARD ?? quote.exchange.label,
    price,
    previousClose: quote.previousClose,
    dailyChange: quote.dailyChange,
    fairValue,
    valueLabel: reliableForecast ? `NTM · ${forecastCount}家机构` : fairValue ? "年报盈利锚" : null,
    opportunityScore,
    qualityScore,
    marginOfSafety,
    status,
    modelStatusReason,
    risk,
    catalyst: profitGrowth > 20 ? "Growth acceleration" : marginOfSafety > 10 ? "Valuation reset" : operatingCashFlow > 0 ? "Cash-flow durability" : "Earnings normalization",
    revenue,
    revenueGrowth,
    profitGrowth,
    netMargin,
    grossMargin,
    operatingMargin: null,
    fcfMargin: null,
    freeCashFlow: null,
    operatingCashFlow,
    earningsValue: fairValue,
    cashFlowValue: null,
    salesValue: null,
    dcfValue: null,
    relativeValue: fairValue,
    dividendYield: null,
    annualDividend: null,
    payoutRatio: null,
    marketCap: quote.marketCap,
    floatMarketCap: quote.floatMarketCap,
    eps,
    fcfPerShare: null,
    roe,
    currentRatio: numberOrNull(annual?.LD),
    debtToEquity: debtRatio == null ? null : debtRatio / Math.max(1, 100 - debtRatio),
    debtRatio,
    bookValuePerShare,
    netDebtPerShare: null,
    cashToDebt: null,
    fcfToDebt: null,
    interestCoverage: numberOrNull(annual?.INTEREST_COVERAGE_RATIO ?? annual?.INTSTCOVRATE),
    assets: numberOrNull(annual?.TOTAL_ASSETS_PK),
    liabilities: numberOrNull(annual?.LIABILITY),
    cash: null,
    totalDebt: null,
    equity: numberOrNull(annual?.TOTAL_EQUITY_PK),
    financialHistory,
    multiples: {
      pe: quote.pe,
      forwardPe: valuationEps > 0 && price ? price / valuationEps : null,
      pb: quote.pb,
      ps: revenue > 0 && quote.marketCap ? quote.marketCap / revenue : null,
      pfcf: null,
      earningsMultiple: baseMultiple,
      fcfMultiple: null,
      earningsAnchor: fairValue,
      cashFlowAnchor: null,
      salesMultiple: null,
      salesAnchor: null,
    },
    valuationModel: {
      model: reliableForecast ? "机构前瞻 EPS 情景估值" : "最近年报 EPS 盈利锚",
      weights: { earnings: fairValue ? 100 : 0, dcf: 0 },
      assumptions: { growth: growthProfile, wacc: null, terminalGrowth: null, forecastYears: 5 },
      scenarios,
      scenarioInputs: valuationEps > 0 ? {
        eps: valuationEps,
        epsSource: sourceLabel,
        epsYear: valuationYear,
        epsLow: bearEps,
        epsHigh: bullEps,
        estimates: reliableForecast ? forecastCount : null,
        isForecast: reliableForecast,
        sourceType,
        currentYearEps: reliableForecast ? forwardEps : null,
        currentYearEpsYear: reliableForecast ? forecast?.YEAR2 : null,
        nextYearEps: reliableForecast ? nextForwardEps : null,
        nextYearEpsYear: reliableForecast ? forecast?.YEAR3 : null,
        forwardEpsGrowth: reliableForecast ? forecastGrowth : profitGrowth,
        growthProfile,
        bearMultiple,
        baseMultiple,
        bullMultiple,
        justifiedMultiple,
        historicalMultiple,
        historicalSamples: valuationHistory?.historySamples ?? 0,
        historicalPb: valuationHistory?.historicalPb ?? null,
        multiYearYears: 5,
        multiYearGrowth: longTermGrowth * 100,
        multiYearMultiple: clamp(baseMultiple + 3, 12, 27),
        multiYearBullTarget,
      } : null,
      sensitivity: { growth: [], rows: [] },
      impliedGrowth: null,
      note: fairValue
        ? reliableForecast
          ? `基准价值使用未来12个月 EPS ${valuationEps.toFixed(2)} 元 × ${baseMultiple.toFixed(1)} 倍混合市盈率；PE 由增长合理值 ${justifiedMultiple.toFixed(1)} 倍与三年历史中位 ${historicalMultiple?.toFixed(1) ?? "—"} 倍加权。`
          : `该数字只是最近年报 EPS ${valuationEps.toFixed(2)} 元 × ${baseMultiple.toFixed(1)} 倍形成的盈利锚，不等同于完整的今日合理价值。`
        : modelStatusReason,
    },
    drawdown30d: null,
    turnover: quote.turnover,
    fiscalDate: String(latest?.REPORT_DATE ?? annual?.REPORT_DATE ?? "").slice(0, 10) || null,
    marketDate: quote.marketDate,
    quoteSource: "东方财富公开行情",
    sourceUrl: `https://quote.eastmoney.com/${quote.exchange.suffix.toLowerCase()}${meta.symbol}.html`,
    confidence: reliableForecast && forecastCount >= 5 ? "Medium" : "Low",
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

async function getChinaStock(meta, force = false, batchQuote = null, quoteWarning = null, forecast = null, forecastWarning = null, valuationHistory = null, valuationWarning = null) {
  const cached = stockCache.get(meta.symbol);
  if (!force && cached?.stock && cached.expiresAt > Date.now()) return { ...cached.stock, sourceOrder: meta.sourceOrder };
  if (!force && cached?.pending) return cached.pending.then((stock) => ({ ...stock, sourceOrder: meta.sourceOrder }));
  const entry = cached ?? {};
  entry.pending = Promise.allSettled([Promise.resolve(batchQuote ?? unavailableQuote(meta)), fetchChinaFinancials(meta.symbol)])
    .then(([quoteResult, financialResult]) => {
      const quote = quoteResult.status === "fulfilled" ? quoteResult.value : unavailableQuote(meta);
      const rows = financialResult.status === "fulfilled" ? financialResult.value : [];
      const warnings = [
        quoteWarning,
        forecastWarning,
        valuationWarning,
        quoteResult.status === "rejected" && `行情暂不可用：${quoteResult.reason?.message ?? "未知错误"}`,
        financialResult.status === "rejected" && `财报暂不可用：${financialResult.reason?.message ?? "未知错误"}`,
      ].filter(Boolean);
      return { ...buildChinaStock(meta, quote, rows, forecast, valuationHistory), dataWarnings: warnings };
    })
    .then((stock) => {
      entry.stock = stock;
      entry.expiresAt = Date.now() + (stock.dataWarnings?.length ? 2 : 30) * 60 * 1000;
      return stock;
    })
    .finally(() => { entry.pending = null; });
  stockCache.set(meta.symbol, entry);
  return entry.pending.then((stock) => ({ ...stock, sourceOrder: meta.sourceOrder }));
}

async function hydrateChinaStocks(items, force, errors) {
  const stale = items.filter((meta) => {
    const cached = stockCache.get(meta.symbol);
    return force || !cached?.stock || cached.expiresAt <= Date.now();
  });
  let quotes = new Map();
  let forecasts = new Map();
  let valuationHistories = new Map();
  let batchError = null;
  let forecastError = null;
  let valuationError = null;
  if (stale.length) {
    const [quoteResult, forecastResult, valuationResult] = await Promise.allSettled([
      fetchChinaQuotes(stale),
      fetchChinaForecasts(stale),
      fetchChinaValuationHistory(stale),
    ]);
    if (quoteResult.status === "fulfilled") quotes = quoteResult.value;
    else {
      batchError = `批量行情暂不可用：${quoteResult.reason?.message ?? "未知错误"}`;
      errors.push(batchError);
    }
    if (forecastResult.status === "fulfilled") forecasts = forecastResult.value;
    else {
      forecastError = `盈利预测暂不可用：${forecastResult.reason?.message ?? "未知错误"}`;
      errors.push(forecastError);
    }
    if (valuationResult.status === "fulfilled") valuationHistories = valuationResult.value;
    else {
      valuationError = `历史估值暂不可用：${valuationResult.reason?.message ?? "未知错误"}`;
      errors.push(valuationError);
    }
  }
  return mapWithConcurrency(items, 4, async (meta) => {
    try {
      const needsRefresh = stale.some((item) => item.symbol === meta.symbol);
      const quote = needsRefresh ? quotes.get(meta.symbol) ?? unavailableQuote(meta) : null;
      const warning = needsRefresh && !quotes.has(meta.symbol) ? batchError ?? "批量行情未返回该股票" : null;
      const forecast = needsRefresh ? forecasts.get(meta.symbol) ?? null : null;
      const valuationHistory = needsRefresh ? valuationHistories.get(meta.symbol) ?? null : null;
      return await getChinaStock(meta, force, quote, warning, forecast, needsRefresh ? forecastError : null, valuationHistory, needsRefresh ? valuationError : null);
    } catch (error) {
      errors.push(`${meta.symbol}: ${error.message}`);
      return { ...buildChinaStock(meta, unavailableQuote(meta), [], null, null), dataWarnings: [`数据暂不可用：${error.message}`] };
    }
  });
}

async function getFullList(list, universe, force, errors) {
  const signature = `${list.modifiedAt}:${list.symbols.join(",")}`;
  const cached = fullListCache.get(list.id);
  if (!force && cached?.signature === signature && cached?.stocks && cached.expiresAt > Date.now()) return cached.stocks;
  if (!force && cached?.pending) return cached.pending;
  const entry = cached ?? {};
  entry.signature = signature;
  entry.pending = hydrateChinaStocks(universe, force, errors).then((stocks) => {
    entry.stocks = stocks;
    entry.expiresAt = Date.now() + 30 * 60 * 1000;
    return entry.stocks;
  }).finally(() => { entry.pending = null; });
  fullListCache.set(list.id, entry);
  return entry.pending;
}

async function loadChinaData({ watchlistId, presetId = "all", page, pageSize }, force) {
  const lists = await loadChinaWatchlists();
  const activeList = lists.find((list) => list.id === watchlistId) ?? lists[0];
  const universe = activeList.stocks.map((stock, index) => ({ ...stock, sourceOrder: index + 1 }));
  const errors = [];
  let stocks;
  let total;
  if (presetId === "all") {
    total = universe.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    page = clamp(page, 1, pageCount);
    const start = (page - 1) * pageSize;
    stocks = await hydrateChinaStocks(universe.slice(start, start + pageSize), force, errors);
  } else {
    const allStocks = await getFullList(activeList, universe, force, errors);
    const filtered = allStocks.filter((stock) => matchesPreset(stock, presetId));
    total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    page = clamp(page, 1, pageCount);
    const start = (page - 1) * pageSize;
    stocks = filtered.slice(start, start + pageSize);
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startIndex = (page - 1) * pageSize;
  const marketDates = stocks.map((stock) => stock.marketDate).filter(Boolean).sort();
  const fiscalDates = stocks.map((stock) => stock.fiscalDate).filter(Boolean).sort();
  return {
    market: "cn",
    currency: "CNY",
    stocks,
    generatedAt: new Date().toISOString(),
    watchlists: lists.map((list) => ({ id: list.id, title: list.title, total: list.total, updated: list.updated, filename: list.filename, symbols: list.symbols })),
    activeWatchlist: { id: activeList.id, title: activeList.title, total: activeList.total, updated: activeList.updated, filename: activeList.filename, sourcePath: activeList.filePath },
    pagination: { page, pageSize, total, totalPages, start: total ? startIndex + 1 : 0, end: Math.min(startIndex + pageSize, total) },
    screening: { presetId, scope: presetId === "all" ? "current-page" : "full-watchlist", sourceTotal: activeList.total, totalMatches: total },
    marketDataAsOf: marketDates.at(-1) ?? null,
    fundamentalsAsOf: fiscalDates.at(-1) ?? null,
    partial: errors.length > 0,
    errors,
    sources: [
      { name: "东方财富公开行情", url: "https://quote.eastmoney.com/" },
      { name: "东方财富公开财务数据", url: "https://data.eastmoney.com/" },
    ],
    methodology: "A 股优先采用未来12个月 EPS，并将增长合理 PE（65%）与近三年历史 PE 中位数（35%）加权；样本不足时只显示最近完整年报盈利锚。Bear / Base / Bull 与多年目标分开显示。",
    disclaimer: "模型估值仅供研究，不构成投资建议。",
  };
}

export async function getChinaPayload(params, force = false) {
  const key = `${params.watchlistId}:${params.presetId}:${params.page}:${params.pageSize}`;
  const cached = responseCache.get(key);
  if (!force && cached?.payload && cached.expiresAt > Date.now()) return { ...cached.payload, cache: "hit" };
  if (!force && cached?.pending) return cached.pending;
  const entry = cached ?? {};
  entry.pending = loadChinaData(params, force).then((payload) => {
    entry.payload = payload;
    entry.expiresAt = Date.now() + 30 * 60 * 1000;
    return { ...payload, cache: "miss" };
  }).finally(() => { entry.pending = null; });
  responseCache.set(key, entry);
  return entry.pending;
}
