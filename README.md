# dsh-plugin-cost-meter

[![npm version](https://img.shields.io/npm/v/dsh-plugin-cost-meter)](https://www.npmjs.com/package/dsh-plugin-cost-meter)
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
- **Weekday-aware peak tiers** — DeepSeek bills peak only **Monday–Friday**; weekends are off-peak all day. The schedule is configurable (windows, weekdays, multiplier, time zone).
- **Silent price sync** — a bundled price catalog plus an out-of-band remote catalog refreshed on an interval. Push a new `catalog/prices.json` and every installed copy picks it up **without a plugin release**; a failed refresh keeps the last good rates.
- **Explicit peak/off-peak rates** — models may carry an explicit discounted pair (`cacheMiss` + `cacheMissOffPeak`), not just a multiplier.
- **Route-aware matching** — `provider/model`, `provider/*`, `*`-model wildcards, and case/space/punctuation-insensitive model ids.
- **Never fakes a number** — an unpriced route renders `未配置` (`unpriced`) instead of a made-up fallback rate.

## Install

### From npm (recommended)

```cmd
dsh plugin --profile web add dsh-plugin-cost-meter
```

The package declares `dsh.bundle`, so `dsh plugin add` activates it as a profile layer automatically — no manual `cordis.patch.yml` row is required.

### From a local checkout

```cmd
dsh plugin --profile web add "link:E:/path/to/dsh-plugin-cost-meter"
```

`link:` keeps the checkout live, so edits apply after a `dsh web` restart without reinstalling.

Restart the server afterwards:

```cmd
dsh web
```

## Configure

The bundled `cordis.patch.yml` inserts the plugin row with defaults. Override it by adding a `cost-meter` row with the same `id` in your profile's `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: cost-meter
      name: dsh-plugin-cost-meter
      config:
        currency: CNY                 # display currency; empty = catalog currency
        fx:
          cnyPerUsd: 7.1              # used when the catalog is USD and you display CNY
        catalogUrl: ""                # "" = this package's own catalog (derived from repository)
        refreshMinutes: 360           # silent refresh interval; 0 disables it
        pricingTimeoutMs: 4000
        pricingUrl: ""                # optional legacy { models, default } document
        models:                       # manual overrides (highest priority, display currency)
          deepseek-official/deepseek-flash:
            inputPerM: 1.06           # off-peak base
            cacheReadPerM: 0.021
            cacheWritePerM: 1.06
            outputPerM: 4.26
        default:                      # optional fallback; omit to report unknown routes as unpriced
          inputPerM: 1
          outputPerM: 4
        peak:
          enabled: true
          multiplier: 2               # used only when a rate has no explicit off-peak value
          timezoneOffsetMinutes: 480  # UTC+8
          days: [1, 2, 3, 4, 5]       # ISO weekdays; weekends are off-peak
          windows: [[9, 12], [14, 18]]
```

Two rate styles are accepted everywhere:

- **Catalog style** (peak base + optional off-peak): `cacheMiss`, `cacheHit`, `cacheWrite`, `output`, and `cacheMissOffPeak`, `cacheHitOffPeak`, `cacheWriteOffPeak`, `outputOffPeak`.
- **Legacy style** (off-peak base): `inputPerM`, `cacheReadPerM`, `cacheWritePerM`, `outputPerM` (with optional `*Peak` fields).

## Automatic price updates

Prices resolve in this order (highest wins):

1. `config.models` / `config.default`
2. `config.pricingUrl` (legacy document)
3. the **remote catalog** at `config.catalogUrl` — default: this package's own `catalog/prices.json` on GitHub, derived from `package.json.repository`
4. the **bundled** `catalog/prices.json` (offline fallback)

A timer re-reads the remote catalog and `pricingUrl` every `refreshMinutes` (default 6 hours) and swaps the live table in place:

- a failed refresh **keeps the last successful data**;
- a source that never loaded does not clear anything;
- a price change applies to the whole session on the **next event**, and immediately on a page reload.

This makes the catalog the single place to maintain rates: **edit and push `catalog/prices.json`, and installed copies update themselves** — no new plugin release. Forks get their own update channel automatically because the default URL is derived from `package.json.repository`.

To point at a private mirror or a local file, set `catalogUrl` (`https://…`, a path, or `file:///…`). Set it to `""` to disable remote syncing.

## Peak / off-peak

- Tiering uses the **request's own `event.time`**, never "now".
- Peak applies only on the configured weekdays (`days`, default Monday–Friday); weekends are off-peak all day.
- The schedule comes from the catalog's `peakSchedule` (time zone, days, windows, off-peak ratio) and can be overridden field by field in `config.peak`.
- `peak.enabled: false` bills one flat rate; `peak.timezoneOffsetMinutes` shifts the wall clock for the window check.

The hover tooltip shows the current tier, the multiplier, the route, and the token breakdown.

## Pricing model

```
cost = Σ_routes [ cost_off(route) + cost_peak(route) ]

cost_tier(route) = (uncachedInput × miss
                  + cacheRead     × hit
                  + cacheWrite    × write
                  + output        × out) / 1_000_000
```

Totals are accumulated per `{ provider, model }` route and per tier, so switching models mid-session keeps each route on its own price. A repeated usage sample for the same `(turn, step)` replaces the earlier one instead of double-counting.

## Compatibility

| Surface | DSH ≤ 0.1.0-rc.6 | DSH ≥ 0.1.5 |
|---|---|---|
| Projection contract | `schema` + `view` | `stateSchema` + `wire: { viewSchema, view }` |
| Client deps | `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-ui-renderer`, `@deepseek-ai/dsh-client-ui-session` |
| Compatibility gate | — | `engines.dsh` / `peerDependencies` must satisfy the running version |

The badge uses the additive `conversation.session.header.utilities` slot; `…header.corner` is a `single` slot already occupied by a shipped plugin.

## Development

```cmd
npm install
npm test
```

`test/contract.test.mjs` covers the projection contract, weekday peak, catalog parsing, explicit dual rates, currency conversion, normalization/wildcards, unpriced routes, and manual overrides. It runs offline (`catalogUrl: ""`).

## Notes

- Costs are **estimates**: they depend on the provider-reported `usage` and on the price table.
- The badge is **per session**; it does not aggregate sub-sessions or the whole account.
- The bundled catalog is a dated snapshot — verify it against the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing) and update `catalog/prices.json` when rates change.
- The plugin is a Web surface plugin; compositions without `sessionProjections` (e.g. headless) skip registration.

## License

[MIT](LICENSE)
