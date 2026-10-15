/**
 * 卖后回补。研究默认。
 * 跌了大约 20% 本身永远不够。要有回踩均线、平台突破或相对强度修复，并且多周期确认。
 */

function nearHeld(last, ema, atr) {
  if (!(ema > 0) || !(last > 0)) return false;
  const band = Math.max(ema * 0.012, atr > 0 ? atr * 0.5 : ema * 0.012);
  return last >= ema && last <= ema + band;
}

function freshBreakout(last, baseHigh) {
  if (!(baseHigh > 0) || !(last > baseHigh)) return false;
  return (last - baseHigh) / baseHigh < 0.05;
}

function rsRecovered(rs20, rs20Prev) {
  return rs20 != null && rs20Prev != null && rs20 > 0 && rs20Prev <= 0;
}

export function reentryTriggerText({ ema20, ema50, baseHigh } = {}) {
  const fmt = (value) => (value == null ? null : Number(value).toFixed(2));
  const emas = [fmt(ema20) && `EMA20 ${fmt(ema20)}`, fmt(ema50) && `EMA50 ${fmt(ema50)}`].filter(Boolean).join(' / ');
  const base = baseHigh ? `收盘突破平台 ${fmt(baseHigh)}` : '收盘突破已经形成的平台高点';
  return `卖出后只在回踩 ${emas || 'EMA20 / EMA50'} 并收在均线上方、${base}、或 20 日相对 SPY 超额由非正转正时考虑。跌了 20% 本身不是理由。`;
}

export function evaluateReentry(input = {}) {
  const qty = Number(input.qty);
  if (qty > 0) {
    return {
      allowed: false,
      setup: null,
      action: 'NO_TRADE',
      reason: 'in-position',
      reasons: ['还在仓里，回补条件只作为下一次的触发说明']
    };
  }
  const last = Number(input.last);
  const atr = Number(input.atr14);
  const pullback = nearHeld(last, Number(input.ema20), atr) || nearHeld(last, Number(input.ema50), atr);
  const breakout = freshBreakout(last, Number(input.baseHigh));
  const rs = rsRecovered(input.rs20, input.rs20Prev);
  let setup = null;
  if (pullback && (input.regime === 'StrongTrend' || input.playbook === 'trend-follow')) setup = 'pullback-to-ema';
  else if (breakout && input.regime !== 'DownTrend' && input.regime !== 'HighVolEvent') setup = 'breakout-of-base';
  else if (rs && (input.regime === 'StrongTrend' || input.regime === 'Range')) setup = 'rs-recovery';

  const drop = Number(input.dropFromExitPct);
  if (!setup) {
    if (Number.isFinite(drop) && drop <= -20) {
      return {
        allowed: false,
        setup: null,
        action: 'NO_TRADE',
        reason: 'rebuy-down-20-alone',
        reasons: ['相对卖出价下跌约 20%，没有合格结构，不回补']
      };
    }
    return {
      allowed: false,
      setup: null,
      action: 'NO_TRADE',
      reason: input.regime === 'unknown' || !input.regime ? 'regime-unknown' : 'rebuy-needs-setup',
      reasons: ['没有回踩均线、平台突破或相对强度修复']
    };
  }
  if (input.mtfConfirmed !== true) {
    return {
      allowed: false,
      setup,
      action: 'NO_TRADE',
      reason: 'mtf-unconfirmed',
      reasons: [`看到 ${setup}，但日线或完整周线没有确认，不加`]
    };
  }
  if (input.playbook === 'defend' || input.regime === 'DownTrend' || input.regime === 'HighVolEvent') {
    return {
      allowed: false,
      setup,
      action: 'NO_TRADE',
      reason: 'regime-defend',
      reasons: ['当前剧本是防守，不因为形态回补']
    };
  }
  if (input.addsBlocked === true) {
    return {
      allowed: false,
      setup,
      action: 'NO_TRADE',
      reason: 'breadth-risk-off',
      reasons: ['SPY 和 QQQ 都在 200 日均线下方，研究默认暂停新回补']
    };
  }
  const add = input.rebuyAdd === true || Number(input.rebuyTranche) >= 2;
  return {
    allowed: true,
    setup,
    action: add ? 'REBUY_ADD' : 'REBUY_1_3',
    reason: add ? 'rebuy-add' : 'rebuy-first-third',
    reasons: [`回补结构 ${setup} 通过，参考${add ? '再补一档' : '先试 1/3'}。不计算实盘股数。`]
  };
}
