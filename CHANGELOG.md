# Changelog

All notable changes to this project are documented here.

## 0.6.0

- **Historical costs are now frozen.** An amount is computed and stored when
  its usage sample is folded, and `wire.view` only sums the stored amounts.
  Previously the view re-priced the whole token history with the live table,
  so a price update (or a catalog refresh) rewrote past sessions' totals.
  Price updates now apply to samples folded after them only.
- Replacing a duplicated sample (`chunk` → `message`) subtracts the frozen
  amount of the sample it replaces, so dedup stays exact.
- The currency a session is counted in is stored with the state, so a later
  `currency` change does not silently reinterpret old amounts.
- Projection state bumped to `stateVersion 4`. The persisted projection cache
  is invalidated once on upgrade, so every session is re-folded against the
  current table at that moment (the same table the badge already displayed),
  then frozen from there on.
- Two regression tests: a price swap leaves counted samples untouched, and a
  sample replacement subtracts exactly.

## 0.5.2

- The remote catalog's `peakSchedule` now overrides the bundled snapshot, so a
  schedule change pushed to `catalog/prices.json` reaches installed copies
  (previously the bundled schedule always won).
- Header badge sizing fixed: `box-sizing: border-box`, `height: 24px`,
  `border-radius: var(--dsw-radius-sm)` — the badge previously rendered
  ~46px tall and no longer matched the header controls (e.g. the 24px
  `.OMoRSG_split` control).

## 0.5.1

- Manual `config.models` entries now outrank every automatic source even at
  equal specificity (previously a same-route catalog entry could win). Added a
  regression test for the tie-break.

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
