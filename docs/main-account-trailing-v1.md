# 主账户动态止盈观察 V1.0 / Main-account trailing observer

状态：观察与建议。研究草案，不是已验证的盈利模型，也不是下单指令。

Status: observation and suggestions only. This is a research draft, not a proven payoff model and not an order.

## 适用范围 / Scope

规则只写 **7811/主账户权益**。操作者把 Robinhood wealth equity book **••••3469** 当作这份观察的账户尾号，所以 `account` / `accountLast4` 为 `main`、`7811` 或 `3469` 都会跑观察。**7983 期权账户排除**，哪怕同时写了 `main-trailing`。不修改 7983 短周期权预筛，也不改成交归集里 3469→tactical、7983→agentic 的映射。

The rules describe **7811 / main equity**. Robinhood **••••3469** is the operator's wealth-book label and also turns the observer on. **7983 options stay excluded.** The 7983 prefilter and the fill-routing map are unchanged.

今日自营规模大约 **$10,000–$15,000**。下面的百分比、k 和回撤带都是这个规模上的**研究默认 / research defaults**，不是实盘授权。先监控，不自动减仓，不读券商密钥，不发单。

## R 与分批兑现 / R and scale-out

R 是入场时的原始每股价差：`R = entry − invalidation`。entry 用 `avgCost`。失效价用 `invalidation`。

- 浮盈 **+2R**：参考兑现 **20%–25%**，动作码 `TRIM_25`。调用方标明 `trendHealthy: true` 且没有 `overheated` 时，可以暂缓为 `HOLD`。
- 浮盈 **+3R**：若 +2R 那一档已经标成 `trimmed2R`，再参考兑现 **20%–30%**，仍是 `TRIM_25`。
- 若到了 +3R 却还没做过 +2R 减仓，参考把两档并成约 **40%–55%**，动作码 `TRIM_50`。余下大约 45%–60% 留给趋势退出。
- 这些百分比是参考区间。输出里的 `orderQty` 固定为 null，不编造股数。

At **+2R**, the reference trim is **20–25%** (`TRIM_25`). An explicit healthy-trend flag may defer it. At **+3R**, take another **20–30%** if the first trim is already marked; if it is not, `TRIM_50` stands for the combined **40–55%** reference. No share count is produced.

## ATR 追踪 / ATR trail

`Stop_t = max(Stop_(t-1), peak_close − k × ATR14)`

已经记录的止损用持仓上的 `stop`。最高日收盘用 `peakClose`。k 的研究默认取对照区间的下沿，不是拟合出来的最优值：

| 波动分类 `volClass` | 研究默认 k | 对照区间 |
| --- | --- | --- |
| `growth` / `cycle`（缺省也算成长） | 2.5 | 2.5 与 3.0 |
| `event` / `high-vol` | 3.0 | 3.0 与 3.5 |

传入的 `k` 只有落在 2.5–3.5 才采用。追踪线只许上移，不许因为回撤放宽。现价触及或跌破失效价、已记录止损或这条追踪线时，建议是 `EXIT`，优先于止盈。止损触发价不是成交价。

The published k is the low end of each comparison pair. The stop ratchets up only. A touch of invalidation, the recorded stop, or the trail suggests `EXIT` before any trim. A stop trigger is not a fill.

## 高水位 / High-water mark

用调用方给的 `hwmNav` 和 `nav` 计算回撤。这里不推断入金出金；资金流调整后的高水位请先算好，并设 `hwmFlowAdjusted: true`。

| 回撤 | `hwmBand` | `riskMode` | 含义（只监控） |
| --- | --- | --- | --- |
| 0%–6% | `0-6` | `normal` | 正常观察 |
| 6%–10% | `6-10` | `reduce` | 提示暂停主动加高 Beta |
| 10%–15% | `10-15` | `reduce` | 提示降低风险预算 |
| ≥15% | `15+` | `contract` | 提示收缩，不自动砍仓 |

`riskMode` **不改写**动作码。Monitor only: the hint does not rewrite the action code and does not send an order.

## 主题集中度 / Theme concentration

持仓带 `marketValue` 时，按 `theme` 加总，权重分母优先用 `nav`。同一驱动因素的参考上限是 **35%–45%**。超过 35% 标 `aboveReference`，超过 45% 再标 `aboveUpperReference`。单票参考上限：成长/周期 **8%–12%**，事件/高波动 **4%–8%**。越线只打标，不因此改动作。

Theme weights are sums of `marketValue`. Crossing the reference band raises a review flag. It does not change the suggested action.

计划价差风险（大约单笔 0.5%–0.75%、未保护仓位合计 4%–5%）仍是研究参考。本助手不算可买股数。

## 卖后回补 / Rebuy

不允许只因为「比卖出价跌了约 20%」就回补。那种输入的动作是 `NO_TRADE`。

要有下面之一，才进入候选：

1. `trend` / `pullback`：趋势回调企稳。
2. `breakout`：整理或平台后再突破。
3. `panic-recovery`：恐慌后修复，并且仍能定义失效价。

首次是 `REBUY_1_3`（参考计划仓位的 1/3）。`rebuyAdd: true` 或 `rebuyTranche >= 2` 为 `REBUY_ADD`。仍然不计算股数。卖出后直接上涨、不再追回，是允许的结果。

A 20% decline alone is `NO_TRADE`. Rebuy requires trend, breakout, or panic-recovery. First pass is `REBUY_1_3`; a later confirmation is `REBUY_ADD`.

## 动作码 / Action codes

`HOLD` | `TRIM_25` | `TRIM_50` | `EXIT` | `REBUY_1_3` | `REBUY_ADD` | `NO_TRADE`

缺少数量、成本或现价时用 `NO_TRADE`，并在 `missing` 里写缺口。缺 ATR 或最高收盘时，追踪线留空，R 倍数建议仍可给出。期权腿和空头不是这套规则的对象。

## 何时叫醒 / When the heartbeat wakes

`node scripts/bot-heartbeat.js --input snapshot.json --routine main-trailing --exit-code`

退出码 10 只在这三件事发生时出现：

1. `suggestedAction` 相对上一份状态变了。
2. 出现新的 −7% 警报（沿用午间规则，同一只继续跌不算新警报）。
3. 净值、数量或止损指纹变了。指纹仍不含现价。

现价在同一动作码里晃动：退出码 0。只抬高 `hwmNav` 而动作码不变：也是 0。状态默认写到 `data/bot/main-trailing.json`。字段说明见 [bot-usage.md](bot-usage.md)。
