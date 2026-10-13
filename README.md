# KawaiiStock

本地运行的股票账户研究台。页面、API、观察池、期权研究和纸上实验共用一个 Node.js 服务。研究输出不等于实盘下单。

## 启动

需要 Node.js 22。首次使用时，将 `data/accounts.example.json` 复制为 `data/accounts.json`，再按自己的账户和本地资料修改。示例配置不含真实持仓。

```powershell
npm ci
Copy-Item data/accounts.example.json data/accounts.json
npm test
npm start
```

默认地址为 `http://127.0.0.1:3479`。资料目录默认在仓库下的 `vault/`（`src/paths.js`），也可以用环境变量指到本机 Obsidian。目录不存在时，启动日志会写出缺失路径。观察清单缺失时，股票池、推荐和每日观察回退到内置 public-demo，并在结果里写明。可选环境变量见 `.env.example` 和 `.env.options.example`。

`data/` 下的实际账户配置、持仓、纸上账本、风控状态，以及 `reports/` 下的研究记录均不提交。带个人电脑挂载路径的 `docker-compose.yml` 也仅留在本机。容器示例见 `docker-compose.example.yml`：根文件系统只读，期权前向采集默认关闭，不下实盘单。
