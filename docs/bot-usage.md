# Kawaii 美股 routine：先看脚本，再决定要不要叫模型

这些脚本把名单翻译、午间比对、短周期权筛选从模型里挪走。Robinhood 的下单和撤单仍然只走 bot + connector。脚本不读密钥，也不发单。

退出码：加上 `--exit-code` 时，`0` 表示保持沉默，`10` 表示需要叫模型。不加这个参数时，进程退出码是 0，调用方看 JSON 里的 `no_change`。

## 什么时候沉默

| 场景 | 先跑 | 沉默条件 | 醒来之后 |
| --- | --- | --- | --- |
| 午间 :25 / :55，以及任何持仓决策环 | `node scripts/bot-heartbeat.js --input snapshot.json --routine midday-7983 --exit-code` | `no_change: true` | 把 `wakes` 交给模型。进入止损唤醒区时每次都醒 |
| 每小时名单 | `node scripts/bot-list-summary.js --scan scan.json --exit-code` | `text` 为 `NO_CHANGE` | 原样转发 `text`，不要再让模型翻译升/降/异动 |
| 7983 短周期权，约每 15 分钟 | `node scripts/bot-options-prefilter.js --chain chain.json --exit-code` | `no_change: true` | 模型只确认 `candidates`。下单仍由 connector 执行 |
| 论坛扫描 | `node scripts/forum-aggregate.js --watchlist watch.json --exit-code` | `aggregate.json` 的 `silent: true` | 只给相对 overheard 账本的新指纹分 A/B。见 [forum-scan-prefetch.md](forum-scan-prefetch.md) |

`no_change: true` 或 `silent: true` 时：不要呼叫模型，不要发帖，不要写分类。

## 午间决策环

`snapshot.json` 可以是持仓快照，也可以只是一份状态 JSON。

```json
{
  "routine": "midday-7983",
  "nav": 5123.4,
  "positions": [
    { "symbol": "NVDA", "qty": 10, "side": "long", "last": 180.2, "stop": 170 }
  ]
}
```

也可以不给持仓，改传 `--state state.json`。脚本按稳定键序做哈希，只重排字段不会醒。

默认把状态写到 `data/bot/heartbeat.json`（`data/` 不入库）。下一轮拿这一份做对照。

默认阈值：

- 净值变动超过 30 bps 才醒。小波动和慢止盈保持沉默。
- 止损距离 ≤ 1%：每次都醒，即使持仓和净值没变。
- 止损距离在 3% 以内，并且又靠近至少 0.5 个百分点：醒。
- 代码、方向、数量、止损价本身变了：醒。
- 第一次没有上一份状态：醒一次，用来建立基线。

止损可以来自 `stop`、`stopPrice`，或现成的 `stopDistancePct`。空头用 `(stop - last) / last`。

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

三类都空，输出就是 `NO_CHANGE`。

## 短周期权预筛

输入是链或报价 dump，不是下单请求。认 `contracts`、`calls`/`puts`，或 `chains[]`。

默认只留下同时满足这些条件的合约：

- DTE 2 到 14 天（含端点）。0DTE / 1DTE 记入 `blockedShortDated`，不进候选。
- `|delta|` 在 0.15 到 0.55。
- 权利金（mid，或 bid/ask 中点）不超过每股 $5。`--max-premium none` 可以关掉金额上限。

到期日按美东 `--as-of` 计算；省略时用研究台的美东交易日。`premiumCost` 是每股权利金乘 100 的参考金额，不是订单。

候选为空时 `no_change: true`。有候选时，模型只做确认；成交仍由 bot + connector 完成。

## 论坛扫描

盒子上的绝对路径、指纹和 overheard 账本见 [forum-scan-prefetch.md](forum-scan-prefetch.md)。论坛没有单独的仓库，脚本放在这里。

安静扫描先跑 `node scripts/forum-aggregate.js`。它会写 cashtag/关键词新闻、Yahoo 与无鉴权 Robinhood 报价，以及 14 日财报和 EDGAR Form 4 / 8-K 清单。清单文件是 `us-forum-event-checklist.json`，放在 `/workspace/forum-scan/state/` 和 `/workspace/stock-playbook/state/`。`silent: true` 表示指纹已经在 overheard 账本里，不要再让模型上网，也不要分 A/B。
