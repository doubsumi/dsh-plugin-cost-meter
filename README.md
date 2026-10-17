# dsh-cost-meter

[![npm version](https://img.shields.io/npm/v/dsh-cost-meter)](https://www.npmjs.com/package/dsh-cost-meter)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)](https://github.com/topics/dsh-plugin)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a **live cost badge in the conversation header (top-right)** and prices every request with **peak / off-peak (time-of-day) tiers**.

```
┌──────────────────────────────────────────────────────────────┐
│  Session title                                [¥0.0042]      │   ← badge here
├──────────────────────────────────────────────────────────────┤
│  … conversation …                                            │
└──────────────────────────────────────────────────────────────┘
```

## Features

- **Live** — the badge updates as the host reports provider usage; no polling, no timers.
- **Historically correct** — each request is priced by its **own wall-clock timestamp**, so a session that spans peak and off-peak stays accurate even if the page sits open overnight.
- **Peak / off-peak tiers** — DeepSeek's official rule (peak = 2× off-peak, Beijing `09:00–12:00` and `14:00–18:00`) is the default, and every part is configurable (window, multiplier, time zone).
- **Per-model accounting** — switching models mid-session keeps each model's tokens on its own price.
- **Configurable prices** — override manually, or auto-fetch a JSON price document at boot.
- **Non-invasive** — registers into the existing header utilities slot; renders nothing while there is no usage.

## Install

### From npm (recommended)

```cmd
dsh plugin --profile web add dsh-cost-meter
```

The package declares `dsh.bundle`, so `dsh plugin add` activates it as a profile layer automatically — no manual `cordis.patch.yml` row is required.

### From a local checkout

```cmd
dsh plugin --profile web add "link:E:/path/to/dsh-cost-meter"
```

`link:` keeps the checkout live, so edits apply after a `dsh web` restart without reinstalling.

Then restart the server:

```cmd
dsh web
```

## Configure

Configuration lives on the profile plugin row. The bundled `cordis.patch.yml` inserts the row with defaults; override it by adding a `cost-meter` row with the same `id` in your profile's `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: cost-meter
      name: dsh-cost-meter
      config:
        currency: CNY                     # ISO 4217; default USD
        pricingUrl: ""                    # optional JSON price source (URL or file path)
        pricingTimeoutMs: 4000            # fetch timeout before falling back
        models:                           # per-model OFF-PEAK rates, per 1M tokens
          deepseek-flash:
            inputPerM: 1.5                # uncached input
            cacheReadPerM: 0.05           # cache-hit input
            cacheWritePerM: 1.5           # cache-write input
            outputPerM: 4.5               # output
          deepseek-v4-pro:
            inputPerM: 4.5
            cacheReadPerM: 0.15
            cacheWritePerM: 4.5
            outputPerM: 13.5
        default:                          # fallback for unlisted models
          inputPerM: 1.5
          cacheReadPerM: 0.05
          cacheWritePerM: 1.5
          outputPerM: 4.5
        peak:
          enabled: true                   # false ⇒ one flat (off-peak) rate
          multiplier: 2                   # peak = off-peak × multiplier
          timezoneOffsetMinutes: 480      # UTC+8 (Beijing)
          windows: [[9, 12], [14, 18]]    # peak windows, local wall clock
```

Price resolution order (highest wins): **manual `config.models` / `config.default` → fetched `pricingUrl` document → bundled defaults**.

### Auto-fetching a price document

DeepSeek does not publish a stable machine-readable price endpoint, so the plugin accepts any JSON document you host:

```json
{
  "currency": "CNY",
  "models": {
    "deepseek-flash": { "inputPerM": 1.5, "cacheReadPerM": 0.05, "cacheWritePerM": 1.5, "outputPerM": 4.5 }
  },
  "default": { "inputPerM": 1.5, "cacheReadPerM": 0.05, "cacheWritePerM": 1.5, "outputPerM": 4.5 }
}
```

Point `config.pricingUrl` at an `https://` URL, a local path, or a `file://` URL. A failed fetch logs a warning and falls back to the bundled defaults.

## Pricing model

For every model the projection keeps two buckets — **off-peak** and **peak** — and the cost is:

```
cost = Σ_models [ cost_off(m) + cost_peak(m) × multiplier ]

cost_tier(m) = (uncachedInput × inputPerM
              + cacheRead     × cacheReadPerM
              + cacheWrite    × cacheWritePerM
              + output        × outputPerM) / 1_000_000
```

The tier is chosen from the request's own `event.time` at fold time, so the stored state stays price-independent: editing prices and restarting re-prices cached buckets without replaying the log.

## Compatibility

| Surface | DSH ≤ 0.1.0-rc.6 | DSH ≥ 0.1.5 |
|---|---|---|
| Projection contract | `schema` + `view` | `stateSchema` + `wire: { viewSchema, view }` |
| Client deps | `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-ui-renderer`, `@deepseek-ai/dsh-client-ui-session` |
| Compatibility gate | — | `engines.dsh` / `peerDependencies` must satisfy the running version |

- A projection without `wire` registers **host-only** and never reaches the browser — the badge would render nothing, silently.
- `engines.dsh` is declared as `>=0.1.5-rc.1 <1.0.0`; narrow ranges such as `^0.1.5-rc.1` are rejected by the 0.2.1 runtime gate.
- The badge uses the additive `conversation.session.header.utilities` slot. `…header.corner` is a `single` slot already occupied by a shipped plugin, so it cannot be used.

## Development

```cmd
npm install
npm test
```

`test/contract.test.mjs` mocks the small slice of Cordis that `apply()` touches and drives the projection with synthetic session events (contract shape, peak/off-peak split, dedup, model switch, fallback pricing).

## Notes

- Costs are **estimates**: they depend on the provider-reported `usage` and on your price table. DeepSeek currently bills peak/off-peak; keep `config.models` in sync with the official rates.
- The badge is per-session. It does not aggregate sub-sessions or the whole account.
- The plugin is a Web surface plugin; compositions without `sessionProjections` (e.g. headless) skip registration.

## License

[MIT](LICENSE)
