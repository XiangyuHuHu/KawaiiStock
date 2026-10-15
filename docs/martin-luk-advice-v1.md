# Martin Luk 启发正股建议 V1

状态：给 **Kawaii美股** 读的参考。不是下单指令。`liveTrading`、`placesOrders`、`brokerOrders`、`autoTrade7811` 都固定为 false。Self-Directed **7811** 仍只观察、只纸上。本报告的 OwnerBot 是 **Kawaii小胡**。

研究全文：[`rules/martin-luk-strategy-source-v1.md`](../rules/martin-luk-strategy-source-v1.md)。  
美股操作备忘：[`rules/martin-luk-inspired-v1.md`](../rules/martin-luk-inspired-v1.md)。

【M】是 Martin 本人公开陈述或原文。 【A】是为了能每天生成报告而补的工程口径，标成 **待回测**，不是他的原规则。

这层不替换决策卡、主账户追踪、Risk Gateway、小鱼点位、评分、Critic 或事件闸。决策卡只有在调用方另外传入 `martin` 时才多一块并列说明，`suggestedAction` 和 `orderQty` 不变。见 [quant-v1.md](quant-v1.md)。

期权不在这里。本模块不读取、不改写 `short-dated-options-v1` / Buy Call 的数字。

## 美股 bot 怎么拿

按需生成，不自动下单：

```text
node scripts/martin-advice.js
node scripts/martin-advice.js --symbols NVDA,MU
node scripts/martin-advice.js --date 2026-10-15 --no-write
node scripts/martin-advice.js --input payload.json --out reports
npm run martin:advice
```

`--input` 的 JSON 可以带 `asOf`、`rows`（每行有 `symbol`、`bars`，以及可选的市值、`volatility1wPct`、`premarketChangePct`）、`positions`、`spyBars`、`qqqBars`。没有 `--input` 时，脚本读观察名单，再用主要流动性美股补齐，并尝试拉日线。盘前、市值或平台波动率缺失就留空，不编造。

接口：

- `GET /api/martin/advice`
- `GET /api/martin/advice?symbols=NVDA,MU&write=0`
- `POST /api/martin/advice`，正文与 `--input` 相同。`write: false` 只返回、不落盘。

产物（`reports/` 不进 git）：

- `reports/YYYY-MM-DD-martin-luk-advice.json`
- `reports/YYYY-MM-DD-martin-luk-advice.md`

Kawaii美股读完 JSON 之后，仍走自己账户上已有的闸。这份文件不能当订单。

## 报告字段

| 字段 | 含义 |
| --- | --- |
| `asOf` | 美东交易日 |
| `regime.hint` | `RISK_ON` / `NEUTRAL` / `RISK_OFF` / `UNKNOWN`。工程提示【A】，待回测 |
| `candidates[]` | `symbol`、`scan`、`stage`、`planned_stop`、`r_notes`、`action`、`reasons` |
| `action` | `WATCH`、`BUY_REF`、`HOLD_REF`、`NO_TRADE` |
| `stopChecklist[]` | 只列建议新开。每条 `stopMustPlaceAfterFill: true`，文句是「成交后立刻挂 GTC stop」 |
| `disclaimers` | 参考边界 |
| `brokerOrderId` | 永远是 null。不编造券商订单号 |

`stage` 是 `LEAD` / `MEDIOCRE` / `LAG` / `TRANSITION`。`scan` 形如 `potent`、`premarket`、`leader`，多套同时通过时用 `+` 连起来。

## 扫描（待回测）

三套门槛来自 2025-02-02 本人回复【M2】。下表右侧是本模块的归一化，口径可能和原扫描平台不同【A】。

| 扫描 | 【M】公开条件 | 【A】本模块 |
| --- | --- | --- |
| Potent | 市值 > 1 亿；Volatility 1W > 3.5%；价格 > 21EMA；Vol×Price > 5000 万 | 市值、Volatility 1W 只接受调用方传入。缺失不臆造，也不用 ADR 或一周涨幅填 Volatility 1W。价格用已完成日 K 收盘对 21EMA。Vol×Price 用最近一根的成交量×收盘价，不用 10 日平均成交额 |
| Premarket | 市值 > 1 亿；10 日均量 > 50 万股；Vol×Price > 5000 万；按盘前涨幅降序 | 盘前涨幅只排序。没有盘前数据就空着，不写成 0 |
| Leader | 市值 > 1 亿；10 日均量 > 50 万股；Vol×Price 1W > 3 亿；按近一月表现降序 | 没有平台的 Vol×Price 1W 时，用近 5 日成交额合计近似，并标 `proxy`。近一月表现只排序 |

市值或 Volatility 1W 缺失时，其余已通过的技术条件仍可以留下候选，但 `degraded: true`。给出的市值若不超过 1 亿美元，该扫描不通过。

观察名单优先，然后才是 AAPL、MSFT、GOOGL、AMZN、META、NVDA、AVGO、TSLA、AMD、MU、NFLX、JPM、V、LLY、COST、CRM。按需全表扫描最多 36 个名字【A】。SPY / QQQ 只用来看市场状态，不进候选。调用方点名的代码不截断。

## 入场参考

这些字段写在候选上，供人工看。它们不覆盖已有闸门。

- `planned_stop`：结构失效位。第一次健康回踩用回踩低点【I1】【A】。算不出来就留空，并且不能是 `BUY_REF`。
- ADR 软检查：`ADR20%` 用近 20 根 `(High-Low)/Low` 的平均【A】。止损距离最好不超过约 ½ ADR【M1】。超过了就改为 `WATCH`，**不放宽、也不改紧** `planned_stop`。
- `LEAD`：EMA9 > EMA21 > EMA50。`MEDIOCRE`：均线交错。`LAG`：EMA9 < EMA21 < EMA50【M1】。这是强度分类，不是买卖按钮。
- 偏好突破之后的第一次健康回踩。还停在新高上的突破记成 `BREAKOUT_EXTENDED`，动作为 `WATCH`，不追。Lag 排列里的反弹记成 `LAGGING_BOUNCE`，不是健康回踩。
- `BUY_REF` 要同时满足：至少一套扫描通过（允许降级）、Lead 或 Mediocre、第一次健康回踩、`planned_stop` 在参考收盘下方、ADR 软检查通过、市场状态不是 `RISK_OFF` 或 `UNKNOWN`、而且当前没有持仓。
- 已有持仓用 `HOLD_REF`。均线走弱也不在这里变成卖出指令。
- `r_notes` 里的 R 只用交易前的 `planned_stop`。没有成交就还没有实现 R。禁止事后倒推【M1】。

`RISK_ON` / `NEUTRAL` / `RISK_OFF` 看 SPY 与 QQQ 是否同时站上或同时跌破 21/50 EMA【A】。数据不够就是 `UNKNOWN`。

## 成交后止损清单

备忘里最硬的一条：保护性止损是 **成交成功之后** 才挂，不是买入前先挂【用户口径】。

每条建议新开（`BUY_REF`）都带：

- `stopMustPlaceAfterFill: true`
- 清单文句：`成交后立刻挂 GTC stop`
- 同一个 `planned_stop`
- `brokerOrderId: null`

本模块不连接券商，不代挂止损，也不编造订单号。没有 `BUY_REF` 时，清单是空的。

## 不做什么

- 不打开实盘，不把 `liveTrading` 改成 true。
- 不自动向券商挂止损或买单。
- 不操作 7811。7811 继续走 `docs/main-account-trailing-v1.md` 的观察和纸上账。
- 不改短期期权的止损、止盈和名义上限。
- 不把「每次卖约 10%」或「3×ADR」写成硬止盈【M2】。不把第三方「3–5R 卖 1/3」写进来。
- 不开个股做空。
