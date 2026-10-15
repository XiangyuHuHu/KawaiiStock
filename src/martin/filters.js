import { emaSeries } from '../levels.js';
import { MARTIN_SCAN_DEFAULTS } from './params.js';

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function emaLast(closes, period) {
  const list = (closes || []).filter((value) => value > 0);
  if (list.length < period) return null;
  const series = emaSeries(list, period);
  return series.length ? series[series.length - 1] : null;
}

export function dollarVolume(bar) {
  if (!bar || !(bar.close > 0) || bar.volume == null || !Number.isFinite(Number(bar.volume))) return null;
  return Number(bar.volume) * Number(bar.close);
}

export function dollarVolumeSum(bars, sessions) {
  const window = (bars || []).slice(-sessions);
  if (window.length < sessions) return null;
  let sum = 0;
  for (const bar of window) {
    const value = dollarVolume(bar);
    if (value == null) return null;
    sum += value;
  }
  return sum;
}

export function averageVolume(bars, sessions = 10) {
  const window = (bars || []).slice(-sessions);
  if (window.length < sessions) return null;
  let sum = 0;
  for (const bar of window) {
    if (bar.volume == null || !Number.isFinite(Number(bar.volume))) return null;
    sum += Number(bar.volume);
  }
  return sum / sessions;
}

/** 约一个月的已完成交易日收益。原平台字段是 Perf 1M，这里只做排序用的归一化近似【A】。 */
export function performance1mPct(bars, sessions = 21) {
  if (!bars || bars.length <= sessions) return null;
  const last = bars[bars.length - 1]?.close;
  const base = bars[bars.length - 1 - sessions]?.close;
  if (!(last > 0) || !(base > 0)) return null;
  return (last / base - 1) * 100;
}

function thresholdCheck(row) {
  return {
    id: row.id,
    source: 'M2',
    source_field: row.sourceField,
    normalized_field: row.normalizedField,
    op: row.op,
    threshold: row.threshold,
    value: row.missing ? null : row.value,
    pass: row.missing ? null : Boolean(row.pass),
    missing: Boolean(row.missing),
    blocksWhenMissing: Boolean(row.blocksWhenMissing),
    proxy: Boolean(row.proxy),
    pendingBacktest: true,
    label: '待回测',
    note: row.note || null
  };
}

function summarizeScan(scan, checks) {
  const failed = checks.some((check) => check.pass === false);
  const missingBlocking = checks.some((check) => check.missing && check.blocksWhenMissing);
  const degraded = checks.some((check) => (check.missing && !check.blocksWhenMissing) || check.proxy);
  const pass = !failed && !missingBlocking && checks.some((check) => check.pass === true);
  return {
    scan,
    source: 'M2',
    label: '待回测',
    pendingBacktest: true,
    pass,
    strictPass: checks.every((check) => check.pass === true),
    degraded: Boolean(pass && degraded),
    failed,
    checks
  };
}

function marketCapCheck(input) {
  const defaults = MARTIN_SCAN_DEFAULTS.potent;
  const value = num(input.marketCapUsd);
  return thresholdCheck({
    id: 'market_cap',
    sourceField: 'Market cap',
    normalizedField: 'market_cap_usd',
    op: 'gt',
    threshold: defaults.marketCapGtUsd,
    value,
    missing: value == null,
    pass: value > defaults.marketCapGtUsd,
    blocksWhenMissing: false,
    note: '市值缺失时不臆造；有数值但不超过 1 亿美元则本扫描不通过【M2】【A】'
  });
}

function lastDollarVolume(input, bars) {
  return num(input.volumeTimesPriceUsd) ?? (bars.length ? dollarVolume(bars[bars.length - 1]) : null);
}

/**
 * Potent【M2】：市值 > 1 亿、Volatility 1W > 3.5、收盘 > 21EMA、Vol×Price > 5000 万。
 * Volatility 1W 只接受调用方给的平台字段，不用 ADR、也不用一周涨幅填。
 */
export function evaluatePotent(input = {}) {
  const defaults = MARTIN_SCAN_DEFAULTS.potent;
  const bars = input.bars || [];
  const close = num(input.close) ?? (bars.length ? num(bars[bars.length - 1].close) : null);
  const ema21 = num(input.ema21) ?? emaLast(bars.map((bar) => bar.close), 21);
  const volx = lastDollarVolume(input, bars);
  const volatility = num(input.volatility1wPct);
  const checks = [
    marketCapCheck(input),
    thresholdCheck({
      id: 'volatility_1w',
      sourceField: 'Volatility 1W',
      normalizedField: 'volatility_1w_pct',
      op: 'gt',
      threshold: defaults.volatility1wGtPct,
      value: volatility,
      missing: volatility == null,
      pass: volatility > defaults.volatility1wGtPct,
      blocksWhenMissing: false,
      note: '平台 Volatility 1W 缺失时留空。不用 ADR20，也不用一周涨幅代替【M2】'
    }),
    thresholdCheck({
      id: 'price_gt_ema21',
      sourceField: 'Price',
      normalizedField: 'close_gt_ema21',
      op: 'gt',
      threshold: true,
      value: close != null && ema21 != null ? close > ema21 : null,
      missing: !(close > 0) || !(ema21 > 0),
      pass: close > ema21,
      blocksWhenMissing: true,
      note: '日线收盘相对 21EMA【M2】'
    }),
    thresholdCheck({
      id: 'volume_times_price',
      sourceField: 'Vol × Price',
      normalizedField: 'volume_times_close_last_session',
      op: 'gt',
      threshold: defaults.volumeTimesPriceGtUsd,
      value: volx,
      missing: volx == null,
      pass: volx > defaults.volumeTimesPriceGtUsd,
      blocksWhenMissing: true,
      note: '最近一根已完成 K 的成交量×收盘价，不是 10 日平均成交额【A】'
    })
  ];
  return summarizeScan('potent', checks);
}

/** Premarket【M2】。盘前涨幅只用于排序；缺失则不编造百分比。 */
export function evaluatePremarket(input = {}) {
  const defaults = MARTIN_SCAN_DEFAULTS.premarket;
  const bars = input.bars || [];
  const avg = num(input.avgVolume10d) ?? averageVolume(bars, 10);
  const volx = lastDollarVolume(input, bars);
  const change = num(input.premarketChangePct);
  const checks = [
    marketCapCheck(input),
    thresholdCheck({
      id: 'avg_volume_10d',
      sourceField: 'Avg volume 10D',
      normalizedField: 'avg_volume_10d_shares',
      op: 'gt',
      threshold: defaults.avgVolume10dGtShares,
      value: avg,
      missing: avg == null,
      pass: avg > defaults.avgVolume10dGtShares,
      blocksWhenMissing: true
    }),
    thresholdCheck({
      id: 'volume_times_price',
      sourceField: 'Vol × Price',
      normalizedField: 'volume_times_close_last_session',
      op: 'gt',
      threshold: defaults.volumeTimesPriceGtUsd,
      value: volx,
      missing: volx == null,
      pass: volx > defaults.volumeTimesPriceGtUsd,
      blocksWhenMissing: true,
      note: '最近一根已完成 K 的成交量×收盘价【A】'
    })
  ];
  return {
    ...summarizeScan('premarket', checks),
    premarketChangePct: change,
    premarketChangeMissing: change == null,
    sort: defaults.sort
  };
}

/**
 * Leader【M2】。Vol×Price 1W 若没有平台字段，用近 5 根已完成 K 的成交额合计近似，并标成 proxy【A】。
 * Perf 1M 只排序，不设最低涨幅。
 */
export function evaluateLeader(input = {}) {
  const defaults = MARTIN_SCAN_DEFAULTS.leader;
  const bars = input.bars || [];
  const avg = num(input.avgVolume10d) ?? averageVolume(bars, 10);
  const provided = num(input.volumeTimesPrice1wUsd);
  const proxyValue = provided == null ? dollarVolumeSum(bars, 5) : null;
  const volx = provided ?? proxyValue;
  const performance = num(input.performance1mPct) ?? performance1mPct(bars, 21);
  const checks = [
    marketCapCheck(input),
    thresholdCheck({
      id: 'avg_volume_10d',
      sourceField: 'Avg volume 10D',
      normalizedField: 'avg_volume_10d_shares',
      op: 'gt',
      threshold: defaults.avgVolume10dGtShares,
      value: avg,
      missing: avg == null,
      pass: avg > defaults.avgVolume10dGtShares,
      blocksWhenMissing: true
    }),
    thresholdCheck({
      id: 'volume_times_price_1w',
      sourceField: 'Vol × Price 1W',
      normalizedField: provided != null ? 'volume_times_price_1w_usd' : 'dollar_volume_sum_5d',
      op: 'gt',
      threshold: defaults.volumeTimesPrice1wGtUsd,
      value: volx,
      missing: volx == null,
      pass: volx > defaults.volumeTimesPrice1wGtUsd,
      blocksWhenMissing: true,
      proxy: provided == null && volx != null,
      note: '5 日成交额合计不是原平台 Vol×Price 1W，待回测【A】'
    })
  ];
  return {
    ...summarizeScan('leader', checks),
    performance1mPct: performance,
    performanceMissing: performance == null,
    sort: defaults.sort
  };
}

export function sortByPremarketChange(rows) {
  return [...(rows || [])].sort((a, b) => compareDescNullsLast(
    num(a.premarketChangePct ?? a.scans?.premarket?.premarketChangePct),
    num(b.premarketChangePct ?? b.scans?.premarket?.premarketChangePct),
    a.symbol,
    b.symbol
  ));
}

export function sortByMonthPerformance(rows) {
  return [...(rows || [])].sort((a, b) => compareDescNullsLast(
    num(a.performance1mPct ?? a.scans?.leader?.performance1mPct),
    num(b.performance1mPct ?? b.scans?.leader?.performance1mPct),
    a.symbol,
    b.symbol
  ));
}

function compareDescNullsLast(a, b, symbolA, symbolB) {
  if (a == null && b == null) return String(symbolA || '').localeCompare(String(symbolB || ''));
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a || String(symbolA || '').localeCompare(String(symbolB || ''));
}

export function passingScanLabel(scans) {
  const names = ['potent', 'premarket', 'leader'].filter((name) => scans?.[name]?.pass);
  return names.length ? names.join('+') : null;
}
