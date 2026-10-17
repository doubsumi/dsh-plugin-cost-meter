# dsh-cost-meter

[![npm version](https://img.shields.io/npm/v/dsh-cost-meter)](https://www.npmjs.com/package/dsh-cost-meter)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**会话头部右上角**实时显示当前对话的**消耗金额**，并按**峰谷分时**（高峰/空闲）计价。

```
┌──────────────────────────────────────────────────────────────┐
│  会话标题                                     [¥0.0042]      │   ← 徽章位置
├──────────────────────────────────────────────────────────────┤
│  … 对话内容 …                                                │
└──────────────────────────────────────────────────────────────┘
```

## 特性

- **实时**：宿主上报用量后徽章即更新，不轮询、不定时器。
- **历史准确**：每个请求按**它自己的发生时间**判峰谷，会话横跨峰谷、页面开一夜也不会漂。
- **峰谷分时**：默认 DeepSeek 官方规则（高峰 = 空闲 × 2，北京时间 `09:00–12:00`、`14:00–18:00`），窗口、倍率、时区全部可配。
- **按模型计费**：会话中途切换模型，各模型 token 各自计价。
- **价格可配**：支持手动覆盖，或启动时从 JSON 源自动拉取。
- **非侵入**：注册进现有的会话头部工具区槽位；没有用量时不渲染任何内容。

## 安装

### 从 npm 安装（推荐）

```cmd
dsh plugin --profile web add dsh-cost-meter
```

插件声明了 `dsh.bundle`，`dsh plugin add` 会自动把它注册为 profile 层，**无需手写** `cordis.patch.yml`。

### 本地源码安装

```cmd
dsh plugin --profile web add "link:E:/path/to/dsh-cost-meter"
```

`link:` 方式下改源码后重启 `dsh web` 即可生效，不必重装。

随后重启服务：

```cmd
dsh web
```

## 配置

配置写在 profile 的插件行上。插件自带的 `cordis.patch.yml` 只插入默认行；在**你自己的** `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）里用相同 `id` 覆盖即可：

```yaml
- insert:
    - id: cost-meter
      name: dsh-cost-meter
      config:
        currency: CNY                     # ISO 4217，默认 USD
        pricingUrl: ""                    # 可选：JSON 计价源（URL 或本地路径）
        pricingTimeoutMs: 4000            # 拉取超时，失败则回退内置默认
        models:                           # 各模型【空闲价】，单位：元/百万 token
          deepseek-flash:
            inputPerM: 1.5                # 缓存未命中输入
            cacheReadPerM: 0.05           # 缓存命中输入
            cacheWritePerM: 1.5           # 缓存写入输入
            outputPerM: 4.5               # 输出
          deepseek-v4-pro:
            inputPerM: 4.5
            cacheReadPerM: 0.15
            cacheWritePerM: 4.5
            outputPerM: 13.5
        default:                          # 未列出的模型走这里
          inputPerM: 1.5
          cacheReadPerM: 0.05
          cacheWritePerM: 1.5
          outputPerM: 4.5
        peak:
          enabled: true                   # false ⇒ 退化为单一（空闲）费率
          multiplier: 2                   # 高峰 = 空闲 × 倍率
          timezoneOffsetMinutes: 480      # UTC+8（北京）
          windows: [[9, 12], [14, 18]]    # 高峰窗口（本地墙钟）
```

价格合并优先级（高者胜）：**手动 `config.models` / `config.default` → `pricingUrl` 拉取 → 内置默认**。

### 自动拉取计价

DeepSeek 没有稳定的机器可读计价接口，所以插件接受任意你托管的 JSON 文档：

```json
{
  "currency": "CNY",
  "models": {
    "deepseek-flash": { "inputPerM": 1.5, "cacheReadPerM": 0.05, "cacheWritePerM": 1.5, "outputPerM": 4.5 }
  },
  "default": { "inputPerM": 1.5, "cacheReadPerM": 0.05, "cacheWritePerM": 1.5, "outputPerM": 4.5 }
}
```

`config.pricingUrl` 支持 `https://` URL、本地路径或 `file://` URL。拉取失败会打警告并回退内置默认。

## 计价模型

每个模型保留两个桶——**空闲**与**高峰**：

```
cost = Σ_models [ cost_off(m) + cost_peak(m) × multiplier ]

cost_tier(m) = (未命中输入 × inputPerM
              + 缓存命中   × cacheReadPerM
              + 缓存写入   × cacheWritePerM
              + 输出       × outputPerM) / 1_000_000
```

时段取自请求自身的 `event.time`，因此持久化状态与价格无关：改价后重启即对缓存桶重新计价，无需重放日志。

## 兼容性

| 接口 | DSH ≤ 0.1.0-rc.6 | DSH ≥ 0.1.5 |
|---|---|---|
| 投影契约 | `schema` + `view` | `stateSchema` + `wire: { viewSchema, view }` |
| 客户端依赖 | `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-session` |
| 兼容性闸门 | — | `engines.dsh` / `peerDependencies` 必须满足运行时版本 |

- 投影不写 `wire` 会注册成 **host-only**，值永远到不了浏览器——徽章静默为空。
- `engines.dsh` 声明为 `>=0.1.5-rc.1 <1.0.0`；`^0.1.5-rc.1` 这类窄范围会被 0.2.1 的闸门拒绝。
- 徽章使用增量式的 `conversation.session.header.utilities` 槽位；`…header.corner` 是 `single` 槽位且已被内置插件占用，不能用。
- 模型 id：新版 Flash 模型为 `deepseek-flash`（旧会话日志里的 `deepseek-v4-flash` 仍保留在默认价表里）。

## 开发

```cmd
npm install
npm test
```

`test/contract.test.mjs` 模拟 `apply()` 用到的那一小片 Cordis，用合成会话事件驱动投影（契约形状、峰谷拆分、去重、模型切换、兜底价）。

## 说明

- 金额是**估算**：依赖提供方上报的 `usage` 与你的价格表。DeepSeek 目前按峰谷计价，请让 `config.models` 与官方报价保持一致。
- 徽章是**单会话**口径，不聚合子会话或整个账号。
- 插件面向 Web 表层；没有 `sessionProjections` 的组合（如 headless）会跳过注册。

## 许可证

[MIT](LICENSE)
