# KawaiiStock 决策层 V1

状态：观察和纸上对照。研究默认，不是已验证的盈利模型，也不是下单指令。

`liveTrading`、`liveTradingAuthority`、`placesOrders`、`autoTrade7811`、`brokerOrders` 都固定为 false。决策卡的 `orderQty` 固定为 null。纸上账本只在研究价上改自己的账，不发券商单。

这层接在 [main-account-trailing-v1.md](main-account-trailing-v1.md) 上面。R 倍数、分批兑现、追踪止损只许上移、主题权重和 7811 范围都还用原来的 `src/bot/main-trailing.js`。这里补状态机、多周期、回吐、相对强度和回补闸门。

全市场突破扫描、vectorbt / LEAN 回测、自动下单、让模型看图下单，都不在这一版。

## 1. 状态机

每个标的先算日线特征，再归到一个状态。状态决定允许哪类剧本。

| 状态 | 剧本 | 研究默认条件 |
| --- | --- | --- |
| `StrongTrend` | `trend-follow` | 收盘 > EMA20 > EMA50，且 EMA50 > EMA200（不足 200 根则不要求 EMA200）；ADX14 ≥ 22；20 日结构抬高，或收盘贴近 20 日高点 |
| `Range` | `mean-revert` | 上面和下面都不成立 |
| `DownTrend` | `defend` | 收盘 < EMA20 < EMA50；ADX14 ≥ 18；20 日结构走低，或收盘贴近 20 日低点 |
| `HighVolEvent` | `defend` | 最后一根真实波幅 ≥ 2.5 × ATR14，或 ATR 相对更早的 ATR 放大到 1.6 倍且这根波幅 ≥ 1.5 × ATR14 |
| `unknown` | `defend` | EMA50、ADX14 或 ATR14 算不出来 |

`HighVolEvent` 先判。它表示这一根是冲击，不是「这只股票平时波动大」。平时波动大仍由 `volClass` 决定追踪倍数。

SPY 与 QQQ 若都能算 200 日 EMA，并且两者收盘都在均线下方，记 `breadth: risk-off`，研究默认暂停新的回补。缺一边就不拦截。广度不改写已经持有仓位的减仓动作。

阶段只用在趋势还能描述的时候：

- `启动`：`StrongTrend`，收盘离 EMA20 不足 1.2 个 ATR，ADX14 < 32，60 日结构还没一起抬高。
- `主升`：其余 `StrongTrend`。
- `衰竭`：离 EMA20 达到 3 个 ATR，或收盘跌破仍向上的 EMA20（结构破坏）。
- `震荡`：`Range`。
- `防守`：`DownTrend` 或 `HighVolEvent`。

EMA 用 `src/levels.js` 的递归 EMA。ATR、ADX 用 Wilder 平滑。20 日结构比较最近 20 根和再往前 20 根的高低点。

## 2. 多周期

- 日线：调用方给的日线。传了 `asOf` 时，只用当时已经收盘的 K 线。
- 周线：由日线合成。最后一周如果不是周五收盘，整周丢掉，不参与趋势。
- 小时：只有调用方另外给了小时 K 线才算。这一版页面不拉盘中小时线，所以通常是 `unavailable`。`unavailable` 不单独否决；若给了并且趋势是 `down`，则不确认。

回补要同时满足：日线 `up`，并且至少 20 根完整周线也是 `up`。周线不够或还没走完，就保持不确认。

## 3. ATR、k 和峰值回吐

追踪公式仍是：

`Stop_t = max(Stop_(t-1), peakClose − k × ATR14)`

原来的对照区间不变：成长 / 周期默认 k=2.5（对照 2.5 与 3.0）；事件 / 高波动默认 k=3.0（对照 3.0 与 3.5）。高波动和事件额外列出可试的 k：`2.5 / 3 / 3.5 / 4`。传入的 k，成长和周期仍只接受 2.5–3.5；高波动和事件接受 2.5–4。这些是待回测的格子，不是选出来的最优值。

峰值浮盈回吐：

`givebackPct = (peakClose − last) / (peakClose − entry) × 100`

只在 `peakClose > entry` 时有意义。回吐达到 25% 只打 `givebackWatch`。`givebackChangesAction` 固定是 false。

k 只在两件事上收一档：阶段是衰竭，或 `structureBreak`。收到的止损仍然只许更紧。如果这档更紧的止损被现价碰到，原因是 `atr-trail-tightened`。RSI 高、`extended`、`upTooMuch` 只记成已忽略，不改动作。

持仓上的 `HOLD / TRIM_25 / TRIM_50 / EXIT` 仍由主账户追踪决定。决策卡把 `TRIM_25` 和 `TRIM_50` 收成 `TRIM`，把 `REBUY_1_3` 和 `REBUY_ADD` 收成 `REBUY`。

## 4. 相对强度

`excess20 = 个股 20 日收益 − SPY 20 日收益`

分数只是超额的分档：≥15% 为 92，≥8% 为 78，≥3% 为 66，≥0 为 55，≥−5% 为 40，其余 22。没有 SPY 时分数留空。

行业 ETF 只映射看得准的：`MU / MRVL / INTC / CRDO → SMH`。其他标的不猜测板块。

## 5. 回补

不允许因为相对卖出价跌了约 20% 就买回。`evaluateReentry` 只认三种结构，而且都要多周期确认，并且剧本不是防守：

1. `pullback-to-ema`：收盘在 EMA20 或 EMA50 上方，距离不超过 `max(1.2% × EMA, 0.5 × ATR)`，并且状态是 `StrongTrend`。
2. `breakout-of-base`：收盘刚突破整理平台高点，距离小于 5%。下跌趋势和冲击状态不算。
3. `rs-recovery`：20 日相对 SPY 超额从非正变成正。

通过后动作是 `REBUY_1_3`，已有一档则 `REBUY_ADD`。广度 `risk-off` 时改为 `NO_TRADE`。旧的主账户追踪若只收到 `rebuy: "trend"` 这种字符串、又没有这些证据，仍按原观察接口处理；决策卡和纸上账本不走那条捷径。

## 6. 决策卡

`buildDecisionCard` / `POST /api/quant/decision` 返回一张卡：`regime`、`playbook`、`stage`、`scores.trend`、`scores.exhaustion`、`scores.relativeStrength`、`suggestedAction`、`trailingStop`、`reentryTrigger`、`reasons`。

`GET /api/quant/decision?symbols=MU,BE` 会自己拉日线。拉不到就在卡上留下缺口，不编造价格。页面在「决策」页，没有 Lightweight Charts，所以只渲染卡片和价位文字。

## 7. 7811 纸上账

`seedOwnerPaperBook` 读取 `test/fixtures/positions-2026-10-15.json`。

- 账本名：主人真实持仓纸上账本 · Self-Directed ••••7811。
- `JPMPD` 记现金，约 $50,098.32，不是股票。
- 截图没有现价，Day0 标记等于成本。
- 之后每个 tick 只吃决策卡。`TRIM` 按参考区间下沿卖出整数股，`EXIT` 卖光，`REBUY` 按卖出前计划股数的 1/3 买回。`HOLD` 和 `NO_TRADE` 不产生成交。
- 成交价是调用方给的研究价，或该日最后一根收盘。`paper: true`，`broker: false`。
- 账上保留净值、峰值盈亏、回吐、买入持有净值和止损上移记录，方便以后跟买入持有比。这一版不做这个比较的结论。
- 没有失效价时，第一次能算出 ATR 才写下 `entry − 默认 k × ATR14`，并标明 `research-atr`。这只在纸上账里使用。

接口：`GET /api/quant/paper`，`POST /api/quant/paper/seed`，`POST /api/quant/paper/tick`。心跳只有输入里带了 `quantPaper` 才附上 `quantPaper`，不改原来的沉默条件，也不因此下单。

## 8. 还没做

参数都标了 `research-defaults` 和 `pendingBacktest`。没有样本外结果之前，不能把某一档 k、某一段回吐或某一次纸上盈亏说成策略有效。

Martin Luk 启发的正股扫描和入场建议不在这张卡的动作里。调用方如果另外传入 `martin`，决策卡只多一块并列参考，`suggestedAction` 和 `orderQty` 仍按上面的规则。日报、扫描和成交后止损清单见 [martin-luk-advice-v1.md](martin-luk-advice-v1.md)。
