/**
 * dsh-plugin-cost-meter — host half.
 *
 * Registers a `costUsage` session-projection unit that folds durable provider
 * token usage (the same `assistant/chunk` / `assistant/message` usage samples
 * the built-in token meter consumes) and attributes each step's usage to the
 * `{ provider, model }` route named by the latest `request/header`.
 *
 * Price sources, highest priority first:
 *   1. manual `config.models` / `config.default`   (display currency)
 *   2. legacy `config.pricingUrl` JSON document     (`{ models, default }`)
 *   3. remote catalog `config.catalogUrl`           (default: this package's
 *      own `catalog/prices.json` on GitHub, derived from `package.json`)
 *   4. bundled `catalog/prices.json`                (offline fallback)
 *
 * Silent updates: a timer re-reads the remote catalog / pricingUrl on an
 * interval (`config.refreshMinutes`, default 360) and swaps the live table.
 * A failed refresh keeps the last successful data; a failed source never
 * clears data it did not create. The badge reflects a price change on the
 * next session event (the whole session is re-priced) or a page reload.
 *
 * Peak / off-peak
 * ---------------
 * Each request is tiered by its own `event.time` (never by "now"), and the
 * schedule supports a weekday filter — DeepSeek bills peak only Monday
 * through Friday, so weekends are off-peak all day. Rates may be given as an
 * explicit peak/off-peak pair (`cacheMiss` + `cacheMissOffPeak`) or as a
 * single off-peak base scaled by `peak.multiplier`.
 *
 * Unknown routes are reported as `priced: false` instead of being billed at a
 * made-up fallback rate; the badge shows "unpriced" for them.
 *
 * @module dsh-plugin-cost-meter
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z as zod } from "zod";

/** Cordis plugin name (diagnostics). */
const name = "cost-meter";
/** No required services: `sessionProjections` is an optional capability. */
const inject = [];

/** Built-in schedule: DeepSeek Beijing peak, weekdays only, half price off peak. */
const PEAK_DEFAULTS = {
  enabled: true,
  multiplier: 2,
  ratio: 0.5,
  timezoneOffsetMinutes: 480,
  days: [1, 2, 3, 4, 5],
  windows: [[9, 12], [14, 18]]
};

/** How often a silent refresh runs when `refreshMinutes` is not configured. */
const DEFAULT_REFRESH_MINUTES = 360;
/** Default CNY/USD rate for converting a USD catalog into a CNY display. */
const DEFAULT_CNY_PER_USD = 7.1;

const ZERO_BUCKETS = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return undefined;
  }
}

/** This package's manifest, used to derive the default catalog URL. */
const PACKAGE = readJson(new URL("../package.json", import.meta.url)) ?? {};
/** The bundled offline catalog. */
const BUNDLED_CATALOG = readJson(new URL("../catalog/prices.json", import.meta.url)) ?? { schema: 1, providers: {} };

/** Finite, non-negative number or undefined. */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Matching key: case/space/punctuation-insensitive, bracket annotations dropped. */
function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[（(\[][^)\]）]*[)\]）]/g, "")
    .replace(/[\s\-_.]+/g, "");
}

/** Split a `provider/model` key; a bare key matches any provider. */
function splitKey(key) {
  const index = key.indexOf("/");
  return index < 0 ? { provider: "*", model: key } : { provider: key.slice(0, index), model: key.slice(index + 1) };
}

/**
 * Parse one rate entry. Catalog style (`cacheMiss`/`cacheHit`/`output`, peak
 * base with optional `*OffPeak`) and legacy style (`*PerM`, off-peak base)
 * are both accepted.
 * @returns `{ peak, off }` per-1M buckets, or undefined when incomplete.
 */
function parseRates(entry, { ratio, multiplier }) {
  if (entry == null || typeof entry !== "object") return undefined;
  const catalogStyle = entry.cacheMiss !== undefined || entry.cacheHit !== undefined || entry.output !== undefined;
  if (catalogStyle) {
    const miss = num(entry.cacheMiss);
    const out = num(entry.output);
    if (miss === undefined || out === undefined) return undefined;
    const hit = num(entry.cacheHit) ?? 0;
    const write = num(entry.cacheWrite) ?? miss;
    return {
      peak: { miss, hit, write, out },
      off: {
        miss: num(entry.cacheMissOffPeak) ?? miss * ratio,
        hit: num(entry.cacheHitOffPeak) ?? hit * ratio,
        write: num(entry.cacheWriteOffPeak) ?? write * ratio,
        out: num(entry.outputOffPeak) ?? out * ratio
      }
    };
  }
  const miss = num(entry.inputPerM);
  const out = num(entry.outputPerM);
  if (miss === undefined || out === undefined) return undefined;
  const hit = num(entry.cacheReadPerM) ?? 0;
  const write = num(entry.cacheWritePerM) ?? miss;
  return {
    off: { miss, hit, write, out },
    peak: {
      miss: num(entry.inputPerMPeak) ?? miss * multiplier,
      hit: num(entry.cacheReadPerMPeak) ?? hit * multiplier,
      write: num(entry.cacheWritePerMPeak) ?? write * multiplier,
      out: num(entry.outputPerMPeak) ?? out * multiplier
    }
  };
}

/** `"01:00"` / `1` → hours past midnight (fractional). */
function parseClock(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(String(value ?? "").trim());
  if (match === null) return undefined;
  return Number(match[1]) + Number(match[2] ?? 0) / 60;
}

/** Accept `[[9,12]]`, `[{from:"09:00",to:"12:00"}]`, or `[{fromHour,toHour}]`. */
function parseWindows(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (Array.isArray(item) && item.length === 2) {
      const from = Number(item[0]);
      const to = Number(item[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) out.push([from, to]);
    } else if (item !== null && typeof item === "object") {
      const from = parseClock(item.from ?? item.fromHour);
      const to = parseClock(item.to ?? item.toHour);
      if (from !== undefined && to !== undefined) out.push([from, to]);
    }
  }
  return out;
}

/** Minutes east of UTC for a numeric offset, `UTC+8`, or a well-known zone name. */
function parseOffset(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  const utc = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(text);
  if (utc !== null) return (utc[1] === "-" ? -1 : 1) * (Number(utc[2]) * 60 + Number(utc[3] ?? 0));
  if (/^UTC$/i.test(text)) return 0;
  const named = { "Asia/Shanghai": 480, "Asia/Chongqing": 480, "Asia/Hong_Kong": 480, "Asia/Taipei": 480, "Asia/Tokyo": 540 };
  return named[text];
}

/**
 * Resolve the effective peak schedule from the catalog's `peakSchedule` and
 * the plugin config (config wins field by field).
 */
function resolveSchedule(configPeak, catalogSchedule) {
  const schedule = { ...PEAK_DEFAULTS, days: [...PEAK_DEFAULTS.days], windows: PEAK_DEFAULTS.windows.map((w) => [...w]) };
  if (catalogSchedule !== null && typeof catalogSchedule === "object") {
    const offset = parseOffset(catalogSchedule.timezone);
    if (offset !== undefined) schedule.timezoneOffsetMinutes = offset;
    if (Array.isArray(catalogSchedule.days)) {
      const days = catalogSchedule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      if (days.length > 0) schedule.days = days;
    }
    const windows = parseWindows(catalogSchedule.windows);
    if (windows.length > 0) schedule.windows = windows;
    const ratio = num(catalogSchedule.offPeakRatio);
    if (ratio !== undefined && ratio > 0 && ratio <= 1) schedule.ratio = ratio;
  }
  const source = configPeak ?? {};
  if (typeof source.enabled === "boolean") schedule.enabled = source.enabled;
  if (num(source.multiplier) !== undefined && source.multiplier > 0) schedule.multiplier = source.multiplier;
  if (typeof source.timezoneOffsetMinutes === "number" && Number.isFinite(source.timezoneOffsetMinutes)) schedule.timezoneOffsetMinutes = source.timezoneOffsetMinutes;
  if (Array.isArray(source.days)) {
    const days = source.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length > 0) schedule.days = days;
  }
  const windows = parseWindows(source.windows);
  if (windows.length > 0) schedule.windows = windows;
  const ratio = num(source.offPeakRatio);
  if (ratio !== undefined && ratio > 0 && ratio <= 1) schedule.ratio = ratio;
  return schedule;
}

/** Whether an instant falls inside a peak window on a peak weekday. */
function isPeakAt(timeMs, schedule) {
  if (!schedule.enabled || schedule.days.length === 0 || schedule.windows.length === 0) return false;
  const shifted = new Date(timeMs + schedule.timezoneOffsetMinutes * 60000);
  if (!schedule.days.includes(shifted.getUTCDay())) return false;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  for (const [from, to] of schedule.windows) {
    if (minutes >= from * 60 && minutes < to * 60) return true;
  }
  return false;
}

/** Currency factor between a catalog currency and the display currency. */
function fxFactor(from, to, fx) {
  const source = String(from ?? "").toUpperCase();
  const target = String(to ?? "").toUpperCase();
  if (source === "" || target === "" || source === target) return 1;
  const cnyPerUsd = num(fx?.cnyPerUsd) ?? DEFAULT_CNY_PER_USD;
  if (source === "USD" && target === "CNY") return cnyPerUsd;
  if (source === "CNY" && target === "USD") return 1 / cnyPerUsd;
  return 1;
}

function scaleRates(rates, factor) {
  if (factor === 1) return rates;
  const scale = (bucket) => ({ miss: bucket.miss * factor, hit: bucket.hit * factor, write: bucket.write * factor, out: bucket.out * factor });
  return { peak: scale(rates.peak), off: scale(rates.off) };
}

/** Flatten one catalog document into priced route entries. */
function catalogEntries(catalog, { displayCurrency, fx, schedule, source }) {
  const entries = [];
  const currency = catalog?.currency ?? "USD";
  const factor = fxFactor(currency, displayCurrency, fx);
  for (const [provider, declaration] of Object.entries(catalog?.providers ?? {})) {
    for (const [model, entry] of Object.entries(declaration?.models ?? {})) {
      const rates = parseRates(entry, { ratio: schedule.ratio, multiplier: schedule.multiplier });
      if (rates === undefined) continue;
      entries.push({ provider, model, rates: scaleRates(rates, factor), source });
    }
  }
  return entries;
}

/**
 * Build the live price table: bundled catalog, remote catalog, legacy pricing
 * documents, then manual config (highest priority).
 */
function buildPriceTable({ bundled, remote, legacyDocs = [], config, schedule }) {
  const catalogCurrency = remote?.currency ?? bundled?.currency ?? "USD";
  const displayCurrency = (typeof config?.currency === "string" && config.currency !== "" && config.currency)
    || catalogCurrency;
  const entries = [];
  entries.push(...catalogEntries(bundled, { displayCurrency, fx: config?.fx, schedule, source: "bundled" }));
  if (remote !== undefined) entries.push(...catalogEntries(remote, { displayCurrency, fx: config?.fx, schedule, source: "remote" }));
  for (const doc of legacyDocs) {
    const factor = fxFactor(doc?.currency, displayCurrency, config?.fx);
    for (const [key, entry] of Object.entries(doc?.models ?? {})) {
      const rates = parseRates(entry, { ratio: schedule.ratio, multiplier: schedule.multiplier });
      if (rates === undefined) continue;
      const { provider, model } = splitKey(key);
      entries.push({ provider, model, rates: scaleRates(rates, factor), source: "pricingUrl" });
    }
  }
  for (const [key, entry] of Object.entries(config?.models ?? {})) {
    const rates = parseRates(entry, { ratio: schedule.ratio, multiplier: schedule.multiplier });
    if (rates === undefined) continue;
    const { provider, model } = splitKey(key);
    entries.push({ provider, model, rates, source: "config" });
  }
  const fallback = parseRates(config?.default, { ratio: schedule.ratio, multiplier: schedule.multiplier })
    ?? parseRates(legacyDocs.at(-1)?.default, { ratio: schedule.ratio, multiplier: schedule.multiplier });
  return { currency: displayCurrency, entries, default: fallback };
}

/**
 * Resolve a route's priced entry. Specific beats wildcard; a provider
 * wildcard and a model wildcard are both supported, and a bare model key
 * matches every provider.
 * @returns the matched entry, or undefined when the route is unpriced.
 */
function lookupPrice(table, provider, model) {
  if (table === undefined) return undefined;
  const wantedProvider = norm(provider);
  const wantedModel = norm(model ?? "");
  let best;
  for (const entry of table.entries) {
    if (entry.provider !== "*" && norm(entry.provider) !== wantedProvider) continue;
    if (entry.model !== "*" && norm(entry.model) !== wantedModel) continue;
    const score = (entry.provider === "*" ? 0 : 2) + (entry.model === "*" ? 0 : 2);
    if (best === undefined || score > best.score) best = { entry, score };
  }
  return best?.entry;
}

/** Cost of one token bucket under one rate bucket. */
function costOf(buckets, rate) {
  return (
    buckets.uncachedInputTokens * rate.miss +
    buckets.cacheReadTokens * rate.hit +
    buckets.cacheWriteTokens * rate.write +
    buckets.outputTokens * rate.out
  ) / 1_000_000;
}

/** Disjoint provider usage buckets (reasoning is already inside output). */
const bucketsFrom = (usage) => ({
  uncachedInputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0
});
const bucketsEqual = (a, b) => a.uncachedInputTokens === b.uncachedInputTokens && a.outputTokens === b.outputTokens && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens;
const addBuckets = (a, b) => ({
  uncachedInputTokens: (a?.uncachedInputTokens ?? 0) + b.uncachedInputTokens,
  outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
  cacheReadTokens: (a?.cacheReadTokens ?? 0) + b.cacheReadTokens,
  cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + b.cacheWriteTokens
});
const subBuckets = (a, b) => ({
  uncachedInputTokens: (a?.uncachedInputTokens ?? 0) - b.uncachedInputTokens,
  outputTokens: (a?.outputTokens ?? 0) - b.outputTokens,
  cacheReadTokens: (a?.cacheReadTokens ?? 0) - b.cacheReadTokens,
  cacheWriteTokens: (a?.cacheWriteTokens ?? 0) - b.cacheWriteTokens
});

/** Fetch a JSON document from an http(s) URL, a local path, or a file:// URL. */
async function fetchJson(url, timeoutMs) {
  if (url.startsWith("file://")) return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return JSON.parse(readFileSync(url, "utf8"));
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

/** Default catalog URL derived from the package's repository (fork-friendly). */
function defaultCatalogUrl() {
  const repository = String(PACKAGE.repository?.url ?? "");
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:#.*)?$/.exec(repository.trim());
  return match === null ? "" : `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/catalog/prices.json`;
}

/** The first provider-declared peak schedule in a catalog document. */
function firstSchedule(catalog) {
  for (const declaration of Object.values(catalog?.providers ?? {})) {
    if (declaration?.peakSchedule !== undefined) return declaration.peakSchedule;
  }
  return undefined;
}

/**
 * Load every configured source. Each source fails independently and keeps the
 * previous successful payload, so a transient network error never drops data.
 * @returns `{ table, schedule, remote, legacy }`.
 */
async function loadSources(config, warn, previous) {
  const timeoutMs = num(config.pricingTimeoutMs) ?? 4000;
  let remote = previous?.remote;
  let legacy = previous?.legacy;

  const catalogUrl = config.catalogUrl === undefined ? defaultCatalogUrl() : String(config.catalogUrl ?? "");
  if (catalogUrl !== "") {
    try {
      remote = await fetchJson(catalogUrl, timeoutMs);
    } catch (error) {
      if (previous?.remote === undefined) warn(`catalog ${JSON.stringify(catalogUrl)} unavailable: ${error?.message ?? error}; using the bundled catalog`);
    }
  }
  if (typeof config.pricingUrl === "string" && config.pricingUrl !== "") {
    try {
      legacy = await fetchJson(config.pricingUrl, timeoutMs);
    } catch (error) {
      if (previous?.legacy === undefined) warn(`pricing ${JSON.stringify(config.pricingUrl)} unavailable: ${error?.message ?? error}; using bundled rates`);
    }
  }

  const schedule = resolveSchedule(config.peak, firstSchedule(BUNDLED_CATALOG) ?? firstSchedule(remote));
  const table = buildPriceTable({ bundled: BUNDLED_CATALOG, remote, legacyDocs: legacy === undefined ? [] : [legacy], config, schedule });
  return { table, schedule, remote, legacy };
}

/**
 * Build the `costUsage` projection unit over a live source ref.
 * State is pure token accounting per (route × tier); `wire.view` prices it.
 */
function buildProjection(live) {
  const bucketsSchema = zod.object({
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative()
  }).strict();

  const routeSchema = zod.object({
    provider: zod.string().nullable(),
    model: zod.string().nullable(),
    off: bucketsSchema,
    peak: bucketsSchema
  }).strict();

  const stateSchema = zod.object({
    provider: zod.string().nullable(),
    model: zod.string().nullable(),
    perRoute: zod.record(zod.string(), routeSchema),
    last: zod.union([
      zod.null(),
      zod.object({
        turn: zod.number().int(),
        step: zod.number().int(),
        route: zod.string(),
        tier: zod.enum(["off", "peak"]),
        buckets: bucketsSchema
      }).strict()
    ])
  }).strict();

  const viewSchema = zod.object({
    currency: zod.string(),
    cost: zod.number(),
    priced: zod.boolean(),
    provider: zod.string().nullable(),
    model: zod.string().nullable(),
    currentTier: zod.enum(["off", "peak"]),
    peakMultiplier: zod.number(),
    unpricedRoutes: zod.array(zod.string()),
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative()
  }).strict();

  return {
    key: "costUsage",
    stateSchema,
    init: () => ({ provider: null, model: null, perRoute: {}, last: null }),
    apply(state, event) {
      const liveNow = live.current;
      let provider = state.provider;
      let model = state.model;
      if (event.type === "request/header") {
        const headerConfig = event.data?.header?.config;
        if (typeof headerConfig?.provider === "string" && headerConfig.provider !== "") provider = headerConfig.provider;
        if (typeof headerConfig?.model === "string" && headerConfig.model !== "") model = headerConfig.model;
      }

      let turn;
      let step;
      let usage;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
        turn = event.data.turn;
        step = event.data.step;
        usage = event.data.chunk.usage;
      } else if (event.type === "assistant/message" && event.data?.usage !== undefined) {
        turn = event.data.turn;
        step = event.data.step;
        usage = event.data.usage;
      } else {
        return provider === state.provider && model === state.model ? state : { ...state, provider, model };
      }

      const tier = isPeakAt(event.time, liveNow.schedule) ? "peak" : "off";
      const route = `${provider ?? ""}\u0000${model ?? ""}`;
      const buckets = bucketsFrom(usage);

      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : undefined;
      if (previous !== undefined && previous.route === route && previous.tier === tier && bucketsEqual(previous.buckets, buckets)) {
        return provider === state.provider && model === state.model ? state : { ...state, provider, model };
      }

      const perRoute = { ...state.perRoute };
      if (previous !== undefined) {
        const replaced = { ...(perRoute[previous.route] ?? { provider: null, model: null, off: ZERO_BUCKETS(), peak: ZERO_BUCKETS() }) };
        replaced[previous.tier] = subBuckets(replaced[previous.tier], previous.buckets);
        perRoute[previous.route] = replaced;
      }
      const entry = { ...(perRoute[route] ?? { provider, model, off: ZERO_BUCKETS(), peak: ZERO_BUCKETS() }) };
      entry.provider = provider;
      entry.model = model;
      entry[tier] = addBuckets(entry[tier], buckets);
      perRoute[route] = entry;

      return { provider, model, perRoute, last: { turn, step, route, tier, buckets } };
    },
    wire: {
      viewSchema,
      view(state) {
        const liveNow = live.current;
        const table = liveNow.table;
        const totals = ZERO_BUCKETS();
        const unpriced = [];
        let cost = 0;
        for (const entry of Object.values(state.perRoute)) {
          const matched = lookupPrice(table, entry.provider, entry.model);
          if (matched === undefined) {
            unpriced.push(`${entry.provider ?? "?"}/${entry.model ?? "?"}`);
          } else {
            cost += costOf(entry.off, matched.rates.off) + costOf(entry.peak, matched.rates.peak);
          }
          totals.uncachedInputTokens += entry.off.uncachedInputTokens + entry.peak.uncachedInputTokens;
          totals.outputTokens += entry.off.outputTokens + entry.peak.outputTokens;
          totals.cacheReadTokens += entry.off.cacheReadTokens + entry.peak.cacheReadTokens;
          totals.cacheWriteTokens += entry.off.cacheWriteTokens + entry.peak.cacheWriteTokens;
        }
        return {
          currency: table.currency,
          cost,
          priced: unpriced.length === 0,
          provider: state.provider,
          model: state.model,
          currentTier: isPeakAt(Date.now(), liveNow.schedule) ? "peak" : "off",
          peakMultiplier: liveNow.schedule.multiplier,
          unpricedRoutes: unpriced,
          ...totals
        };
      }
    },
    stateVersion: 3
  };
}

function warnWith(ctx, message) {
  try {
    if (ctx?.logger?.warn != null) ctx.logger.warn(`[dsh-plugin-cost-meter] ${message}`);
    else console.warn(`[dsh-plugin-cost-meter] ${message}`);
  } catch {
    console.warn(`[dsh-plugin-cost-meter] ${message}`);
  }
}

/**
 * Register the projection and start the silent refresh loop.
 * @param ctx - host root context.
 * @param config - the raw plugin row config.
 */
async function apply(ctx, config) {
  const cfg = config ?? {};
  const live = { current: undefined };
  const warn = (message) => warnWith(ctx, message);

  live.current = await loadSources(cfg, warn, undefined);
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(buildProjection(live));
  });

  const minutes = num(cfg.refreshMinutes) ?? DEFAULT_REFRESH_MINUTES;
  if (minutes > 0) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        live.current = await loadSources(cfg, warn, live.current);
      } catch (error) {
        warn(`price refresh failed: ${error?.message ?? error}; keeping the previous rates`);
      } finally {
        busy = false;
      }
    }, minutes * 60_000);
    timer.unref?.();
    if (typeof ctx.effect === "function") ctx.effect(() => () => clearInterval(timer), "dsh-plugin-cost-meter: price refresh");
  }
}

/** Internal helpers exported for the contract tests. */
const internals = { buildPriceTable, catalogEntries, isPeakAt, lookupPrice, parseRates, resolveSchedule };

export { apply, inject, internals, name };
