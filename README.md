# KawaiiStock

本地运行的股票研究台。日常只做三件事：算卦对照、K 线 / 策略判断、持仓与账户观察。研究输出不等于实盘下单，本服务没有券商下单通道。

## 留下的表面

- **算卦**：梅花个股卦、奇门九宫、方向正确率。接口在 `/api/oracle`、`/api/oracle/symbols`、`/api/oracle/accuracy`、`/api/oracle/current`，给每日意见和外部简报读。
- **算法 / K 线**：观察池筛选、每日观察、周期阶段、价位图和今日买卖草稿。这些是编码后的多空与价位，不是下单。
- **持仓观察**：账户叠加、主账户手改、小账户持仓快照、止损对照、风险视图。只观察，不发实盘单。Self-Directed ••••7811 另有一条只观察的权益追踪：`npm run bot:heartbeat -- --input snapshot.json --routine main-trailing`。它写建议动作，不发单。规则见 `docs/main-account-trailing-v1.md`。
- **纸上实验**：0A–0H 账本还在。0D 跟算卦，0F / 0G / 0H 跟价格结构。0E 只处理已经记在账上的期权（止损、止盈、到期），不再按期权扫描开新仓。
- **每日意见**：综合每日观察、算卦和当日推荐。期权不进这份意见。

## 启动

需要 Node.js 22。首次使用时，将 `data/accounts.example.json` 复制为 `data/accounts.json`，再按自己的账户和本地资料修改。示例配置不含真实持仓。

```powershell
npm ci
Copy-Item data/accounts.example.json data/accounts.json
npm test
npm start
```

默认地址为 `http://127.0.0.1:3479`。资料目录默认在仓库下的 `vault/`（`src/paths.js`），也可以用环境变量指到本机 Obsidian。目录不存在时，启动日志会写出缺失路径。观察清单缺失时，股票池、推荐和每日观察回退到内置 public-demo，并在结果里写明。可选环境变量见 `.env.example`。

`data/` 下的实际账户配置、持仓、纸上账本、风控状态，以及 `reports/` 下的研究记录均不提交。带个人电脑挂载路径的 `docker-compose.yml` 也仅留在本机。容器示例见 `docker-compose.example.yml`：根文件系统只读，不下实盘单。

## 常用命令

- `npm start` / `npm run dev`：研究台
- `npm test`：测试
- `npm run daily`：每日流水（持仓、推荐、模拟、观察、算卦、意见、纸上实验）
- `npm run paper`：纸上账本
- `npm run recs`：生成推荐
- `npm run validate:strategy`：策略验证
- `npm run bot:heartbeat -- --input snapshot.json --routine main-trailing --exit-code`：7811 权益追踪。沉默退出码 0，需要看一眼时退出码 10。午间比对把 `--routine` 换成 `midday`。
