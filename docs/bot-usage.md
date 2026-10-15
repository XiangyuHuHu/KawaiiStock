# Kawaii 美股 routine：先看脚本，再决定要不要叫模型

这些脚本把名单翻译、午间比对、短周期权筛选从模型里挪走。Robinhood 的下单和撤单仍然只走 bot + connector。脚本不读密钥，也不发单。

退出码：加上 `--exit-code` 时，`0` 表示保持沉默，`10` 表示需要叫模型。不加这个参数时，进程退出码是 0，调用方看 JSON 里的 `no_change`。

## 什么时候沉默

| 场景 | 先跑 | 沉默条件 | 醒来之后 |
| --- | --- | --- | --- |
| 午间 :25 / :55 | `node scripts/bot-heartbeat.js --input snapshot.json --routine midday --exit-code` | `fingerprint_unchanged` 且 `new_alerts` 为空 | 指纹变了，或出现新的 −7% 警报 |
| 7811 权益追踪（Kawaii小胡） | `node scripts/bot-heartbeat.js --input snapshot.json --routine main-trailing --exit-code` | 净值/数量/止损指纹未变，没有新的 −7%，且观察动作码未变 | 动作码变了、指纹变了，或新的 −7%。只写建议。美股 bot 不对 7811 下单。见 [main-account-trailing-v1.md](main-account-trailing-v1.md) |
| 每小时名单 | `node scripts/bot-list-summary.js --scan scan.json --exit-code` | 没有升、降、新异动，`text` 为 `NO_CHANGE` | 原样转发短模板 |
| 7983 短周期权，约每 15 分钟 | `node scripts/bot-options-prefilter.js --chain chain.json --exit-code` | `empty_book && !trigger`，或 `fingerprint_unchanged` | 模型只确认新触发。下单仍由 connector 执行 |
| 论坛扫描 | `node scripts/forum-aggregate.js --watchlist watch.json --exit-code` | `aggregate.json` 的 `silent: true` | 只给相对 overheard 账本的新指纹分 A/B。见 [forum-scan-prefetch.md](forum-scan-prefetch.md) |

`no_change: true` 或 `silent: true` 时：不要呼叫模型，不要发帖，不要写分类。

## 和 routine-prompts-us-v1.3 对齐

云端脚本用同一套指纹，方便 routine 先读 JSON 再决定是否沉默。

指纹都是稳定键序的 SHA-256。现价跳动不进指纹。

### 午间

指纹材料只有净值（精确到分）、每条持仓的代码、方向、数量、止损价（精确到分）。止损用 `stop` 或 `stopPrice`。`state` 不进入指纹，也不单独叫醒。

`fingerprint_unchanged: true` 且 `new_alerts` 为空：沉默。

−7% 用 `changePct`，否则用 `(last - prev) / prev`，再否则用 `(last - avgCost) / avgCost`。小于等于 −7 的代码记入 `alerts`。相对上一份状态第一次出现，才放进 `new_alerts`。同一只股票继续跌，不算新警报。

净值差一分、数量变化或止损价变化都会让指纹变化。只是现价在止损附近、但没到新的 −7%，保持沉默。

### Self-Directed ••••7811 权益追踪（Kawaii小胡，只观察）

`ownerBot` 是 `Kawaii小胡`。Kawaii美股继续处理自己能操作的 Robinhood ••••3469 和 ••••7983，不要用这段逻辑给 7811 下单。输出里 `operableByKawaiiMeigu` 和 `autoTrade7811` 都是 false。

`node scripts/bot-heartbeat.js --input snapshot.json --routine main-trailing --exit-code`

只认 Self-Directed **••••7811**（`account: "main"`、`"main-7811"`、`"7811"`，或 `accountLast4` / `accountMask` 为 7811）。**••••3469 和 ••••7983 直接跳过**，`tactical` / `agentic` 也跳过。这一节不改下面的 7983 预筛。阈值是 7811 大账本的研究默认，不是大约 $11k 的 3469，也不是实盘授权。脚本不读密钥，不发单，也不自动减仓。

`JPMPD`（Premium Deposit）记成可取现金 `cashUsd`，不进股票建议。没有现价时用 `costTotal` 做主题成本权重，并且不编造 `last`。2026-10-15 截图见 `test/fixtures/positions-2026-10-15.json`：权益成本约 $655,193，现金约 $50,098。

输入带 7811 标记、`routine: "main-trailing"`，或持仓同时有 `avgCost`、`invalidation`、`atr14`、`peakClose`、`theme` 时，才会附上 `mainTrailing`。账户级还可以给 `nav` 和 `hwmNav`。有 `marketValue` 时主题权重用市值，否则用成本。

每条持仓给出 `r`（入场 − 失效价）、`unrealizedR`、`suggestedTrailStop`、`suggestedAction`。动作码只有 `HOLD`、`TRIM_25`、`TRIM_50`、`EXIT`、`REBUY_1_3`、`REBUY_ADD`、`NO_TRADE`。`orderQty` 始终是 null。

追踪线是 `max(上一档止损, 持仓以来最高收盘 − k × ATR14)`。成长/周期的研究默认 k=2.5（对照 2.5 与 3.0）；事件/高波动 k=3.0（对照 3.0 与 3.5）。k 只能往上收，不能随回撤放宽。高水位回撤带 6% / 10% / 15% 只标注 `riskMode`：`normal`、`reduce`、`contract`，不改动作码。

醒来仍是退出码 10，沉默是 0。三条里中一条就醒：建议动作码相对上一份状态变了；新的 −7% 警报；净值、数量或止损指纹变了。现价在同一动作码里晃动，保持沉默。只改 `hwmNav` 而动作码不变，也沉默。状态文件默认写到 `data/bot/main-trailing.json`，不和午间指纹混用。`--out` 可以改路径。脚本即使用退出码 0 也会覆写这份 JSON。

规则摘要见 [main-account-trailing-v1.md](main-account-trailing-v1.md)。

### 7983 短周期权

`empty_book: true` 且 `trigger: false`：沉默。`book` / `positions` 为空，且预筛候选和 `triggers` 都空。

或者 `fingerprint_unchanged: true`：沉默。指纹是持仓合约（代码、数量、call/put、行权价、到期日）加上本轮触发合约（不含权利金）。同一张触发单下一轮还在，不再叫模型。

### 每小时名单

没有升、没有降、也没有新的异动：`text` 为 `NO_CHANGE`。异动按代码和上一份 `data/bot/list-scan.json` 比较，同一批代码不再发。升和降也要和上一份不同才写进短模板。模板仍是：

```text
【美股名单】
升：MU 观察→核心
降：OKLO
异动：NVDA +3.20%
```

## 名单中文摘要

输入是名单扫描已经写好的 JSON（例如小时扫描的 promote / demote / movers）。脚本不拉取行情。

认这些字段：`promote` / `promoted`，`demote` / `demoted`，`movers` / `moversUp` / `gainers` / `moversDown` / `losers`，以及 `changes[].action` 里带 promote 或 demote 的行。`changePct` 用百分数点数：`3.2` 表示 +3.2%。

有变化时文本固定成这样，bot 直接转发：

```text
【美股名单】
升：MU 观察→核心
降：OKLO
异动：NVDA +3.20%；SMCI -4.13%
```

没有升、降或新异动时，输出就是 `NO_CHANGE`。和上一小时指纹相同也是 `NO_CHANGE`。

## 短周期权预筛

输入是链或报价 dump，不是下单请求。认 `contracts`、`calls`/`puts`，或 `chains[]`。

默认只留下同时满足这些条件的合约：

- DTE 2 到 14 天（含端点）。0DTE / 1DTE 记入 `blockedShortDated`，不进候选。
- `|delta|` 在 0.15 到 0.55。
- 权利金（mid，或 bid/ask 中点）不超过每股 $5。`--max-premium none` 可以关掉金额上限。

到期日按美东 `--as-of` 计算；省略时用研究台的美东交易日。`premiumCost` 是每股权利金乘 100 的参考金额，不是订单。

空仓且没有触发，或触发指纹与上一份 `data/bot/options-7983.json` 相同，则 `silent: true`。新触发才交给模型确认；成交仍由 bot + connector 完成。

## 论坛扫描

盒子上的绝对路径、指纹和 overheard 账本见 [forum-scan-prefetch.md](forum-scan-prefetch.md)。论坛没有单独的仓库，脚本放在这里。

安静扫描先跑 `node scripts/forum-aggregate.js`。它会写 cashtag/关键词新闻、Yahoo 与无鉴权 Robinhood 报价，以及 14 日财报和 EDGAR Form 4 / 8-K 清单。清单文件是 `us-forum-event-checklist.json`，放在 `/workspace/forum-scan/state/` 和 `/workspace/stock-playbook/state/`。`silent: true` 表示指纹已经在 overheard 账本里，不要再让模型上网，也不要分 A/B。
