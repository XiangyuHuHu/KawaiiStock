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

默认地址为 `http://127.0.0.1:3479`。程序通过 `src/paths.js` 中的环境变量读取本地 Obsidian 资料和观察清单；没有这些资料时，相关页面会显示缺数据。可选行情凭据的变量名见 `.env.options.example`。

`data/` 下的实际账户配置、持仓、纸上账本、风控状态，以及 `reports/` 下的研究记录均不提交。带个人电脑挂载路径的 `docker-compose.yml` 也仅留在本机；如需容器运行，可根据 `Dockerfile` 和自己的目录建立 Compose 配置。
