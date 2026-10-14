# 论坛扫描 prefetch

论坛扫描没有单独的 GitHub 仓库。routine 在共享盒子上先读 prefetch，再决定要不要分类。脚本在 KawaiiStock 里，默认写这些绝对路径。

| 路径 | 内容 |
| --- | --- |
| `/workspace/forum-scan/prefetch/quotes-*.json` | 行情上下文。报价带变化默认不唤醒 |
| `/workspace/forum-scan/prefetch/x-news-*.json` | X / 新闻 dump 归一化后的条目 |
| `/workspace/forum-scan/prefetch/events-*.json` | 财报、到期或其他事件 dump |
| `/workspace/forum-scan/state/seen-fingerprints.json` | 已经见过的指纹 |
| `/workspace/forum-scan/state/gate.json` | 本轮是否沉默。routine 先读这个文件 |
| `/workspace/forum-scan/README.md` | 本契约的盒子副本，每次 prefetch 从仓库文档覆盖 |
| `/workspace/overheard-YYYY-MM-DD.md` | 分类账本。日期是美西日历日 |

测试或另一台机器可以用 `--root` 和 `--ledger-dir` 改路径。在共享盒子上不要改，routine 认的就是上面的绝对路径。

## 先读 gate

```bash
node scripts/forum-prefetch.js --quotes quotes.json --x-news x.json --events events.json --exit-code
```

然后读 `/workspace/forum-scan/state/gate.json`。

- `silent: true`（同时 `no_change: true`）：没有新的新闻或事件指纹。不要呼叫模型，不要分 A/B，不要写 overheard。
- `silent: false`：打开 `prefetch` 里的三个文件，只处理 `newFingerprints`。给每条分 `A` 或 `B`，然后记账。

`A` 是值得看一眼的。`B` 是记下即可的。没有 C，也没有「让模型自己再扫一遍时间线」。

报价文件只做上下文。`changePct` 按 1 个百分点取整后指纹不变，就不会因为跳动再写一条唤醒。新闻指纹优先用帖子 `id`；同一条帖子改几个字不会再次唤醒。没有 id 时，用作者、时间和正文。事件指纹是代码、日期、种类和标题。

指纹在 `--ack` 之前不会记成已分类。prefetch 中途失败的话，下一轮仍会把同一批新指纹放进 gate。

## 分类之后记账

`ack.json`：

```json
{
  "items": [
    { "fingerprint": "<gate.newFingerprints 里的值>", "grade": "A", "line": "NVDA 指引上修" }
  ]
}
```

```bash
node scripts/forum-prefetch.js --ack ack.json
```

账本只在有 A/B 被接受时写入或追加：`/workspace/overheard-YYYY-MM-DD.md`。`YYYY-MM-DD` 是 `America/Los_Angeles` 的日历日，不是美东，也不是 UTC。

重复 `--ack` 同一指纹不会再追加一行。`grade` 不是 A 或 B 的条目会跳过，并且不会新建账本。

## dump 里会留下的字段

脚本不调用 X，也不调用券商。它只从本地 dump 复制这些字段：`id`、`author`、`text`、`url`、`createdAt`、`symbols`，以及行情的 `symbol` / `last` / `changePct`，事件的 `symbol` / `date` / `kind` / `title`。不要把密钥放进 dump。

prefetch JSON 带 `liveTrading: false`。这个流程不下一单。
