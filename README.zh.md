# dsh-plugin-cost-meter

[![npm version](https://img.shields.io/npm/v/dsh-plugin-cost-meter)](https://www.npmjs.com/package/dsh-plugin-cost-meter)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**会话头部右上角**实时显示当前对话的**消耗金额**，按**峰谷分时**计价，并**自动静默更新价格**。

```
┌──────────────────────────────────────────────────────────────┐
│  会话标题                                     [¥0.0042]      │   ← 徽章位置
├──────────────────────────────────────────────────────────────┤
│  … 对话内容 …                                                │
└──────────────────────────────────────────────────────────────┘
```

## 特性

- **实时**：宿主上报用量后徽章即更新，不轮询、不定时器。
- **历史准确**：每个请求按**它自己的发生时间**判峰谷，会话横跨峰谷、页面开一夜也不漂。
- **周内高峰**：DeepSeek 高峰只在**周一至周五**，周末全天低谷；窗口、星期、倍率、时区全部可配。
- **静默同步价格**：内置价格目录 + 远程目录定时刷新。**改并推送 `catalog/prices.json` 即可**，已安装的插件自动跟上，无需发新版；刷新失败保留上一次成功的数据。
- **显式峰谷双价**：支持 `cacheMiss` + `cacheMissOffPeak` 这样的成对费率，而不只是乘一个倍率。
- **路由感知匹配**：支持 `provider/model`、`provider/*`、模型通配，模型 id 忽略大小写/空格/标点差异。
- **绝不编造数字**：未配置价格的模型显示**"未配置"**，而不是用一个兜底价假装准确。

## 安装

### 从 npm 安装（推荐）

```cmd
dsh plugin --profile web add dsh-plugin-cost-meter
```

插件声明了 `dsh.bundle`，`dsh plugin add` 会自动把它注册为 profile 层，**无需手写** `cordis.patch.yml`。

### 本地源码安装

```cmd
dsh plugin --profile web add "link:E:/path/to/dsh-plugin-cost-meter"
```

`link:` 方式下改源码后重启 `dsh web` 即可生效。

随后重启服务：

```cmd
dsh web
```

## 配置

插件自带的 `cordis.patch.yml` 只插入默认行；在**你自己的** `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）里用相同 `id` 覆盖：

```yaml
- insert:
    - id: cost-meter
      name: dsh-plugin-cost-meter
      config:
        currency: CNY                 # 显示币种；留空 = 跟随目录币种
        fx:
          cnyPerUsd: 7.1              # 目录是美元、显示人民币时使用
        catalogUrl: ""                # "" = 用本包自带目录（按 repository 推导远程地址）
        refreshMinutes: 360           # 静默刷新间隔；0 表示关闭
        pricingTimeoutMs: 4000
        pricingUrl: ""                # 可选的旧版 { models, default } 文档
        models:                       # 手动覆盖（优先级最高，显示币种）
          deepseek-official/deepseek-flash:
            inputPerM: 1.06           # 空闲价基准
            cacheReadPerM: 0.021
            cacheWritePerM: 1.06
            outputPerM: 4.26
        default:                      # 可选兜底；不写则未命中路由显示"未配置"
          inputPerM: 1
          outputPerM: 4
        peak:
          enabled: true
          multiplier: 2               # 仅在费率没有显式空闲价时使用
          timezoneOffsetMinutes: 480  # UTC+8
          days: [1, 2, 3, 4, 5]       # ISO 星期；周末为空闲
          windows: [[9, 12], [14, 18]]
```

费率支持两种写法：

- **目录风格**（高峰基准 + 可选空闲价）：`cacheMiss`、`cacheHit`、`cacheWrite`、`output`，以及 `cacheMissOffPeak`、`cacheHitOffPeak`、`cacheWriteOffPeak`、`outputOffPeak`。
- **旧版风格**（空闲基准）：`inputPerM`、`cacheReadPerM`、`cacheWritePerM`、`outputPerM`（可加 `*Peak`）。

## 自动更新价格

价格按优先级合并（高者胜）：

1. `config.models` / `config.default`
2. `config.pricingUrl`（旧版文档）
3. **远程目录** `config.catalogUrl` —— 默认由 `package.json.repository` 推导为本包在 GitHub 上的 `catalog/prices.json`
4. 包内自带的 `catalog/prices.json`（离线兜底）

定时器每 `refreshMinutes`（默认 6 小时）重读远程目录与 `pricingUrl`，并**就地替换**生效价格表：

- 刷新失败**保留上一次成功的数据**；
- 从未成功过的源不会清空任何已有数据；
- **历史金额已冻结**：每条用量在折叠时按当时的价格表计价并存入状态，因此改价只影响其后折叠的样本——过去会话的总额不会被重写；
- 冻结的金额随持久化投影缓存保存，重启后仍在；只有完全没有检查点的冷回放才会按当时价格表重新计价。

因此价格只需维护**一处**：**改并推送 `catalog/prices.json`，已安装的插件自动更新**，不用发版。默认地址由 `package.json.repository` 推导，fork 出来的仓库自动拥有自己的更新通道。

需要私有镜像或本地文件时，把 `catalogUrl` 指向 `https://…`、本地路径或 `file:///…`；设为 `""` 可关闭远程同步。

## 峰谷分时

- 时段判定用**请求自身的 `event.time`**，不是"现在"。
- 高峰只在配置的星期生效（`days`，默认周一至周五），周末全天空闲。
- 时段来自目录里的 `peakSchedule`（时区、星期、窗口、低谷比例），并可用 `config.peak` 逐字段覆盖。
- `peak.enabled: false` 退化为固定费率；`peak.timezoneOffsetMinutes` 决定窗口按哪个墙钟判断。

悬停徽章可看到当前时段、倍率、模型路由与 token 明细。

## 计价模型

```
cost = Σ_routes [ cost_off(route) + cost_peak(route) ]

cost_tier(route) = (未命中输入 × miss
                  + 缓存命中   × hit
                  + 缓存写入   × write
                  + 输出       × out) / 1_000_000
```

用量按 `{ provider, model }` 路由 × 时段分别累计，所以中途换模型也各按各的价；同一 `(turn, step)` 重复上报会替换而非重复累计。

## 兼容性

| 接口 | DSH ≤ 0.1.0-rc.6 | DSH ≥ 0.1.5 |
|---|---|---|
| 投影契约 | `schema` + `view` | `stateSchema` + `wire: { viewSchema, view }` |
| 客户端依赖 | `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-session` |
| 兼容性闸门 | — | `engines.dsh` / `peerDependencies` 必须满足运行时版本 |

徽章使用增量式的 `conversation.session.header.utilities` 槽位；`…header.corner` 是 `single` 槽位且已被内置插件占用。

## 开发

```cmd
npm install
npm test
```

`test/contract.test.mjs` 覆盖：投影契约、周内高峰、目录解析、显式双价、币种换算、归一化/通配、未配置路由、手动覆盖。测试离线运行（`catalogUrl: ""`）。

## 说明

- 金额是**估算**：依赖提供方上报的 `usage` 与价格表。
- 徽章是**单会话**口径，不聚合子会话或整个账号。
- 内置目录是某个时点的快照，请对照[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)核对，并在费率变化时更新 `catalog/prices.json`。
- 插件面向 Web 表层；没有 `sessionProjections` 的组合（如 headless）会跳过注册。

## 许可证

[MIT](LICENSE)
