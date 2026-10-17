# Changelog

All notable changes to this project are documented here.

## 0.5.0

- **Automatic silent price updates**: bundled `catalog/prices.json`, an
  out-of-band remote catalog (`catalogUrl`, default derived from the package
  repository), and a periodic refresh (`refreshMinutes`, default 360) that
  swaps the live table in place. A failed refresh keeps the last good rates.
- **Weekday-aware peak hours**: peak now applies only on the configured
  weekdays (`peak.days`, default Monday–Friday), so weekends bill off-peak.
  This fixes weekend over-billing.
- **Explicit peak/off-peak rates**: catalog entries may carry
  `cacheMissOffPeak` / `cacheHitOffPeak` / `outputOffPeak`; the multiplier is
  only a fallback.
- **Route-aware pricing**: usage is bucketed per `{ provider, model }`; lookups
  support `provider/*`, model wildcards, and case/space/punctuation-insensitive
  model ids. Manual config keys may be bare (`deepseek-flash`) or routed.
- **Currency conversion**: a USD catalog can be displayed in CNY via
  `config.fx.cnyPerUsd` (default 7.1).
- **No fabricated prices**: a route with no matching rate reports
  `priced: false` and the badge shows "未配置" instead of a fallback amount.
- Projection state bumped to `stateVersion 3`; tests cover the new behaviour.

## 0.4.0

- Package as a `dsh.bundle` profile layer: `dsh plugin add dsh-plugin-cost-meter`
  now activates the plugin automatically (no manual patch row required).
- Split documentation into an English `README.md` and a Chinese `README.zh.md`.
- Add contract tests (`npm test`), `LICENSE`, `.gitignore`, and `CHANGELOG.md`.
- Add npm/GitHub package metadata (`repository`, `homepage`, `bugs`, `keywords`).

## 0.3.2

- Fix the DSH 0.2.1 compatibility gate: declare `engines.dsh` and widen the
  `@deepseek-ai/dsh-session-projection` peer range to `>=0.1.5-rc.1 <1.0.0`.

## 0.3.1

- Price the new `deepseek-flash` model id (DSH 0.1.7+ adapter catalog); keep
  `deepseek-v4-flash` for replayed older sessions.

## 0.3.0

- Migrate to the DSH >= 0.1.5 session-projection contract:
  `stateSchema` + `wire: { viewSchema, view }`.
- Replace the removed `@deepseek-ai/dsh-client-runtime` client dependency with
  `dsh-client-ui-renderer` and `dsh-client-ui-session`.

## 0.2.0

- Peak/off-peak (time-of-day) pricing: each request is bucketed by its own
  `event.time`, with a configurable multiplier, time zone, and peak windows.

## 0.1.0

- Initial release: per-session cost badge in the conversation header, with a
  configurable price table and an optional JSON price source.
