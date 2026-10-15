# Kawaii 美股 routine：先看脚本，再决定要不要叫模型

午间比对和 Self-Directed ••••7811 权益追踪先走 `scripts/bot-heartbeat.js`。脚本不读密钥，也不发单。研究台没有期权研究界面，每日意见也不收期权。

退出码：加上 `--exit-code` 时，`0` 表示保持沉默，`10` 表示需要叫模型。不加这个参数时，进程退出码是 0，调用方看 JSON 里的 `no_change`。

## 什么时候沉默

| 场景 | 先跑 | 沉默条件 | 醒来之后 |
| --- | --- | --- | --- |
| 午间 :25 / :55 | `node scripts/bot-heartbeat.js --input snapshot.json --routine midday --exit-code` | `fingerprint_unchanged` 且 `new_alerts` 为空 | 指纹变了，或出现新的 −7% 警报 |
| 7811 权益追踪（Kawaii小胡） | `node scripts/bot-heartbeat.js --input snapshot.json --routine main-trailing --exit-code` | 净值/数量/止损指纹未变，没有新的 −7%，且观察动作码未变 | 动作码变了、指纹变了，或新的 −7%。只写建议。美股 bot 不对 7811 下单。见 [main-account-trailing-v1.md](main-account-trailing-v1.md) |

`no_change: true` 或 `silent: true` 时：不要呼叫模型，不要发帖。

## 和 routine 对齐

指纹都是稳定键序的 SHA-256。现价跳动不进指纹。

### 午间

指纹材料只有净值（精确到分）、每条持仓的代码、方向、数量、止损价（精确到分）。止损用 `stop` 或 `stopPrice`。`state` 不进入指纹，也不单独叫醒。

`fingerprint_unchanged: true` 且 `new_alerts` 为空：沉默。

−7% 用 `changePct`，否则用 `(last - prev) / prev`，再否则用 `(last - avgCost) / avgCost`。小于等于 −7 的代码记入 `alerts`。相对上一份状态第一次出现，才放进 `new_alerts`。同一只股票继续跌，不算新警报。

净值差一分、数量变化或止损价变化都会让指纹变化。只是现价在止损附近、但没到新的 −7%，保持沉默。默认写到 `data/bot/heartbeat.json`。

### Self-Directed ••••7811 权益追踪（Kawaii小胡，只观察）

`ownerBot` 是 `Kawaii小胡`。Kawaii美股继续处理自己能操作的 Robinhood ••••3469 和 ••••7983，不要用这段逻辑给 7811 下单。输出里 `operableByKawaiiMeigu` 和 `autoTrade7811` 都是 false。

`node scripts/bot-heartbeat.js --input snapshot.json --routine main-trailing --exit-code`

只认 Self-Directed **••••7811**（`account: "main"`、`"main-7811"`、`"7811"`，或 `accountLast4` / `accountMask` 为 7811）。**••••3469 和 ••••7983 直接跳过**，`tactical` / `agentic` 也跳过。这一节不改 7983 预筛模块。阈值是 7811 大账本的研究默认，不是大约 $11k 的 3469，也不是实盘授权。脚本不读密钥，不发单，也不自动减仓。

`JPMPD`（Premium Deposit）记成可取现金 `cashUsd`，不进股票建议。没有现价时用 `costTotal` 做主题成本权重，并且不编造 `last`。2026-10-15 截图见 `test/fixtures/positions-2026-10-15.json`：权益成本约 $655,193，现金约 $50,098。

输入带 7811 标记、`routine: "main-trailing"`，或持仓同时有 `avgCost`、`invalidation`、`atr14`、`peakClose`、`theme` 时，才会附上 `mainTrailing`。账户级还可以给 `nav` 和 `hwmNav`。有 `marketValue` 时主题权重用市值，否则用成本。

每条持仓给出 `r`（入场 − 失效价）、`unrealizedR`、`suggestedTrailStop`、`suggestedAction`。动作码只有 `HOLD`、`TRIM_25`、`TRIM_50`、`EXIT`、`REBUY_1_3`、`REBUY_ADD`、`NO_TRADE`。`orderQty` 始终是 null。

追踪线是 `max(上一档止损, 持仓以来最高收盘 − k × ATR14)`。成长/周期的研究默认 k=2.5（对照 2.5 与 3.0）；事件/高波动 k=3.0（对照 3.0 与 3.5）。k 只能往上收，不能随回撤放宽。高水位回撤带 6% / 10% / 15% 只标注 `riskMode`：`normal`、`reduce`、`contract`，不改动作码。

醒来仍是退出码 10，沉默是 0。三条里中一条就醒：建议动作码相对上一份状态变了；新的 −7% 警报；净值、数量或止损指纹变了。现价在同一动作码里晃动，保持沉默。只改 `hwmNav` 而动作码不变，也沉默。状态文件默认写到 `data/bot/main-trailing.json`，不和午间指纹混用。`--out` 可以改路径。脚本即使用退出码 0 也会覆写这份 JSON。

规则摘要见 [main-account-trailing-v1.md](main-account-trailing-v1.md)。决策卡和 7811 纸上账见 [quant-v1.md](quant-v1.md)。输入里没有 `quantPaper` 时，心跳不附带纸上账，沉默条件也不变。纸上账不下券商单。

### 7983 预筛模块（不进每日表面）

`src/bot/options-prefilter.js` 仍保留原来的默认值：DTE 2–14、`|delta|` 0.15–0.55、权利金不超过每股 $5。0DTE / 1DTE 不进候选。7811 追踪没有改这个模块，成交归集里 3469→tactical、7983→agentic 也没改。

它不接研究台页面，也不进每日意见。研究台不再提供期权扫描、期权推荐或 `/api/options`。
