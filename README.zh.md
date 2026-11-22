# dsh-plugin-session-guard

[![ci](https://github.com/jjp-111/dsh-session-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/jjp-111/dsh-session-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 的长会话装一道成本闸门。** 到达工具调用阈值先提醒，再由
「上下文 + 成本」闸门判断这个会话是否真的贵；只有真的贵才交接（写交接单、开新会话、
投递提示）。日内熔断计数落盘、单飞锁、幂等交接，都是为了让「该不该换会话」变成一件
不用每次凭感觉判断的事。

## 要解决的问题

Agent 会话每一轮都会重发整个提示词，所以**单次调用的成本随上下文增长**，而多出来的
每一轮价值通常并没有同步增长。常见建议「开个新会话」有两个失败模式：

1. 关得太早：把还要用的上下文扔了，再花钱重建。
2. 关得太晚：后 20 轮的单价是前 20 轮的好几倍。

而「每 40 次工具调用提醒一次」这条规则两头都不准，因为**调用次数不是成本信号**：
20k 上下文里的 40 次很便宜，200k 上下文里的 8 次很贵。

## 它怎么工作

把「什么时候检查」和「该不该交接」拆开：

```
工具调用 ──▶ 到阈值？ ──否──▶ 什么都不做
                │是
                ▼
        成本闸门（上下文 / 成本） ──「未到拐点」──▶ 软提醒：继续干活，别交接
                │「属于长会话」
                ▼
        handoffMode ──ask──▶ 只问用户，不自己开
                │auto
                ▼
        落盘交接单 ─▶ 建会话 ─▶ 改名 ─▶ 投递开始提示
                │
                ▼
        熔断计数落盘（重启不清零）
```

核心设计：**闸门负责判断，阈值只负责触发。** 不够贵的会话只会收到一句「未到拐点，
不要交接」，绝不会收到「去开新会话」的指令。

## 安装

```
dsh plugin --profile <name> add dsh-plugin-session-guard
```

本地开发可直接 link：

```
dsh plugin --profile <name> add "link:/absolute/path/to/dsh-session-guard"
```

装完需重启一次 Host —— `cordis.patch.yml` 只在启动时读取。

## 配置

全部可选，默认值见 [`cordis.patch.yml`](./cordis.patch.yml)。覆盖方式是在自己的
profile patch 层写：

```yaml
- id: session-guard
  config:
    thresholds: [120, 240]
    handoffMode: ask
```

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholds` | `[80, 160, 320]` | 触发检查的工具调用数 |
| `handoffMode` | `ask` | `auto` 插件自己开 · `ask` 只问用户 · `off` 只提醒 |
| `defaultGroup` | 空 | 兜底分组；留空表示「认不出就跳过，不瞎归类」 |
| `maxHandoffs` | `3` | 每个自然日最多自动交接次数 |
| `minGapMs` | `1800000` | 两次交接最小间隔 |
| `gateEnabled` | `true` | 交接前是否跑成本闸门 |
| `gateMinContext` | `180000` | 判定「长会话」的上下文阈值 |
| `gateMaxCost` | `4` | 判定「长会话」的成本阈值（元） |
| `stateDir` | `<cwd>/.team/session-guard` | 急停文件、熔断状态、诊断日志 |

## 设计取舍（审代码时值得看的部分）

1. **失败关闭，绝不失败打开。** 闸门脚本缺失、超时、非预期退出码，一律按「不该交接」
   处理；一个坏掉的闸门永远不会多开一个会话。
2. **熔断计数落盘。** 内存计数会被重启清零，而「重启」恰恰是失控循环里最先做的动作。
   状态写进 `state.json`，读回时归一化（坏 JSON 当 0、跨天归零），并且在交接返回前写盘。
3. **按构造幂等。** 交接单文件名带来源会话 id；同名已存在就拒绝再建，所以「崩溃后重试」
   是安全的。
4. **单飞锁 + 每个 Agent 只交接一次。** 同一时刻只允许一个交接在跑。
5. **子会话永不再交接。** 新会话被改名成带 `【分组】交接：` 前缀；插件看到自己就是这种
   标题时停手，否则会形成无限交接链。
6. **急停是文件不是配置。** `.team/session-guard/PAUSE` 存在即生效、无需重启——事故里
   重启本身就是最慢也最容易出错的一步。
7. **闸门是独立进程。** 它读会话日志、用退出码表态，可以脱离插件单独替换与测试。

## 验证

`npm test` 用假的 `ctx`、假的 `sessions` / `sessionController` 和临时目录跑单测，覆盖：
阈值门控、闸门否决（不交接）、完整成功链路（落单 → 建会话 → 改名 → 投递 → flush → 计数落盘）、
跨阈值幂等、建会话失败、flush 失败、超时、子会话抑制、日内熔断与跨天归零、急停文件、
重启后计数不清零。

## 已知边界

- 分组推断靠约定（标题 `【分组】` 前缀、关键词、报告文件），认不出时**跳过**而不猜。
- 闸门的上限取决于脚本本身；内置默认脚本要求特定的会话日志布局。
- `cordis.patch.yml` 不热重载，改阈值必须重启；这也是 `PAUSE` 存在的理由。
- 写在 DSH `0.2.2-rc.5` 上，宿主 API 可能变动。

## 相关项目

三个项目同一个出发点——**把凭感觉的判断，变成能重跑两次的东西**：

- **[dsh-session-ledger](https://github.com/jjp-111/dsh-session-ledger)** —— 给历史会话定价、回放策略，让规则靠证据选，而不是靠直觉。
- **[novel-lint](https://github.com/jjp-111/novel-lint)** —— 同样的方法用在文字上：给稿子做机械检查。

## 许可

MIT
