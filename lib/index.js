/**
 * dsh-cost-meter — host half (DSH 0.1.5 session-projection contract).
 *
 * Registers a `costUsage` session-projection unit that folds durable provider
 * token usage (the same `assistant/chunk` / `assistant/message` usage samples
 * that `@deepseek-ai/dsh-token-meter` consumes) and attributes each step's
 * usage to the model named by the latest `request/header`.
 *
 * Prices resolve in this priority order (highest wins):
 *   manual `config.models` / `config.default`
 *     > fetched pricing (when `config.pricingUrl` is set and reachable)
 *     > bundled {@link DEFAULT_PRICES} (estimates).
 * All four rates are the OFF-PEAK (base) rate; see `config.peak`.
 *
 * PEAK / OFF-PEAK pricing
 * -----------------------
 * Each request's tokens are bucketed into two time tiers at fold time using
 * the request's own wall-clock timestamp (`event.time`), so the historical
 * cost is exact regardless of when you view the badge. A per-request count is
 * multiplied at read time by the peak multiplier when it fell inside a peak
 * window. DeepSeek's official rule is peak = 2 × off-peak over Beijing windows
 * 9:00–12:00 and 14:00–18:00; that is the default but every aspect is
 * overridable via `config.peak`.
 *
 * The projection STATE stores only token buckets per (model × tier), which is
 * price-independent and plain JSON (persisted-cache safe). `stateVersion`
 * must bump when the state shape or fold semantics change (it did at v2 when
 * per-tier nesting was introduced).
 *
 * The browser half (`./client`) renders this value into the conversation
 * header's right-aligned utilities slot (the top-right corner).
 *
 * @module dsh-cost-meter
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z as zod } from "zod";

/** Cordis plugin name (diagnostics). */
const name = "cost-meter";
/** No required services: `sessionProjections` is an optional capability. */
const inject = [];

/**
 * Bundled fallback price table, currency units per 1,000,000 tokens — these
 * are OFF-PEAK (base) rates. They are ESTIMATES only; DeepSeek's current API
 * pricing is peak/off-peak tiered, so set `config.models` (or `pricingUrl`)
 * to your real numbers. Each entry: `inputPerM` (uncached input),
 * `cacheReadPerM` (discounted cache-hit input), `cacheWritePerM` (cache-write
 * input; 0 when a provider doesn't bill it), `outputPerM` (output).
 */
const DEFAULT_PRICES = {
  // DSH >= 0.1.7 / adapter catalog: the Flash model id dropped the "v4" prefix.
  "deepseek-flash":    { inputPerM: 1.5, cacheReadPerM: 0.05, cacheWritePerM: 1.5, outputPerM: 4.5 },
  "deepseek-v4-pro":   { inputPerM: 4.5, cacheReadPerM: 0.15, cacheWritePerM: 4.5, outputPerM: 13.5 },
  // Historical ids kept so replayed older sessions still price correctly.
  "deepseek-v4-flash": { inputPerM: 1.5, cacheReadPerM: 0.05, cacheWritePerM: 1.5, outputPerM: 4.5 },
  "deepseek-chat":     { inputPerM: 0.27, cacheReadPerM: 0.07, cacheWritePerM: 0.27, outputPerM: 1.1 },
  "deepseek-reasoner": { inputPerM: 0.55, cacheReadPerM: 0.14, cacheWritePerM: 0.55, outputPerM: 2.19 }
};
const DEFAULT_FALLBACK = { inputPerM: 1.5, cacheReadPerM: 0.05, cacheWritePerM: 1.5, outputPerM: 4.5 };

const PRICE_KEYS = ["inputPerM", "cacheReadPerM", "cacheWritePerM", "outputPerM"];

/** Default peak config: DeepSeek Beijing windows, peak = 2× off-peak. */
const DEFAULT_PEAK = { enabled: true, multiplier: 2, timezoneOffsetMinutes: 480, windows: [[9, 12], [14, 18]] };

/** Pick only finite, non-negative numeric price fields from a raw entry. */
function normalizePrice(raw) {
  const out = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const key of PRICE_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** Normalize the `models` map of a pricing document, dropping non-object entries. */
function normalizeModels(raw) {
  const out = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [id, entry] of Object.entries(raw)) {
    const price = normalizePrice(entry);
    if (Object.keys(price).length > 0) out[id] = price;
  }
  return out;
}

/**
 * Resolve the peak config from raw config (defensive). Returns
 * `{ enabled, multiplier, timezoneOffsetMinutes, isPeak }` where `isPeak` is a
 * pure `(timeMs: number) => boolean` matcher.
 */
function resolvePeak(raw) {
  const src = raw?.peak ?? {};
  const enabled = src.enabled !== false;
  const multiplier = typeof src.multiplier === "number" && Number.isFinite(src.multiplier) && src.multiplier > 0
    ? src.multiplier
    : DEFAULT_PEAK.multiplier;
  const timezoneOffsetMinutes = typeof src.timezoneOffsetMinutes === "number" && Number.isFinite(src.timezoneOffsetMinutes)
    ? src.timezoneOffsetMinutes
    : DEFAULT_PEAK.timezoneOffsetMinutes;

  let windows = DEFAULT_PEAK.windows;
  if (Array.isArray(src.windows)) {
    const normalized = src.windows.filter(
      (w) => Array.isArray(w) && w.length === 2 && w.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 24)
    );
    if (normalized.length > 0) windows = normalized.map((w) => [Math.floor(w[0]), Math.floor(w[1])]);
  }

  const isPeak = (timeMs) => {
    if (!enabled || windows.length === 0) return false;
    const shifted = timeMs + timezoneOffsetMinutes * 60_000;
    const d = new Date(shifted);
    const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (const [startH, endH] of windows) {
      const startMin = startH * 60;
      const endMin = endH * 60;
      if (minutesOfDay >= startMin && minutesOfDay < endMin) return true;
    }
    return false;
  };

  return { enabled, multiplier, windows, timezoneOffsetMinutes, isPeak };
}

/** Merge bundled defaults, a fetched document, and manual config (priority). */
function resolvePrices(config, fetched) {
  const currency = (typeof config?.currency === "string" && config.currency !== "" && config.currency)
    || (typeof fetched?.currency === "string" && fetched.currency !== "" && fetched.currency)
    || "USD";

  const models = {};
  for (const [id, entry] of Object.entries(DEFAULT_PRICES)) models[id] = { ...entry };
  for (const [id, entry] of Object.entries(normalizeModels(fetched?.models))) {
    models[id] = { ...(models[id] ?? DEFAULT_FALLBACK), ...entry };
  }
  for (const [id, entry] of Object.entries(normalizeModels(config?.models))) {
    models[id] = { ...(models[id] ?? DEFAULT_FALLBACK), ...entry };
  }

  const fallback = { ...DEFAULT_FALLBACK, ...normalizePrice(fetched?.default), ...normalizePrice(config?.default) };
  return { currency, models, fallback };
}

/** Resolve the OFF-PEAK price entry for a model id, falling back to the default. */
function priceFor(prices, model) {
  if (model != null && prices.models[model] != null) return prices.models[model];
  return prices.fallback;
}

/** Cost of one token bucket under a price entry (the off-peak rate), currency units. */
function costOf(buckets, price) {
  return (
    buckets.uncachedInputTokens * price.inputPerM +
    buckets.cacheReadTokens * price.cacheReadPerM +
    buckets.cacheWriteTokens * price.cacheWritePerM +
    buckets.outputTokens * price.outputPerM
  ) / 1_000_000;
}

/** Disjoint provider usage buckets (reasoning is already inside output). */
const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
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

/**
 * Load a pricing document from a URL (http/https) or a local file path.
 * Rates and `default` are OFF-PEAK base rates; peak doubling is controlled by
 * the plugin `config.peak`, not the pricing document (keep pricing JSON as
 * plain off-peak numbers if you share it across hosts with different peak
 * rules).
 */
async function loadPricingDocument(url, timeoutMs) {
  if (url.startsWith("file://")) return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return JSON.parse(readFileSync(url, "utf8"));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`pricing fetch HTTP ${response.status}`);
  return await response.json();
}

/**
 * Build the `costUsage` projection unit for the current price table and peak
 * rule. State is pure token accounting per (model × tier); `wire.view` prices
 * the tier buckets at read time.
 *
 * DSH 0.1.5 contract: `stateSchema` validates the persisted fold state, and
 * `wire: { viewSchema, view }` is the client-visible value. Omitting `wire`
 * would register a host-only unit whose value never reaches the browser.
 */
function buildProjection(prices, peak) {
  const currency = prices.currency;
  const multiplier = peak.multiplier;

  /** One disjoint usage bucket set. */
  const bucketsSchema = zod.object({
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative()
  }).strict();

  /** Persisted fold state: pure token accounting per (model × tier). */
  const stateSchema = zod.object({
    model: zod.string().nullable(),
    perModel: zod.record(zod.string(), zod.object({ off: bucketsSchema, peak: bucketsSchema }).strict()),
    last: zod.union([
      zod.null(),
      zod.object({
        turn: zod.number().int(),
        step: zod.number().int(),
        model: zod.string(),
        tier: zod.enum(["off", "peak"]),
        buckets: bucketsSchema
      }).strict()
    ])
  }).strict();

  /** Client-visible wire payload. */
  const viewSchema = zod.object({
    currency: zod.string(),
    cost: zod.number(),
    model: zod.string().nullable(),
    currentTier: zod.string(),
    peakMultiplier: zod.number(),
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative()
  }).strict();

  return {
    key: "costUsage",
    stateSchema,
    init: () => ({ model: null, perModel: {}, last: null }),
    // state.perModel[model] = { off: buckets, peak: buckets }
    apply(state, event) {
      // 1. Track the current model (last-wins) from `request/header`.
      let model = state.model;
      if (event.type === "request/header") {
        const nextModel = event.data?.header?.config?.model;
        if (typeof nextModel === "string" && nextModel !== "") model = nextModel;
      }

      // 2. Extract a usage sample from the two events that carry one.
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
        return model === state.model ? state : { ...state, model };
      }

      // 3. Tier the request by its own wall-clock time. Price-independent.
      const tier = peak.isPeak(event.time) ? "peak" : "off";
      const bucketKey = model ?? "unknown";
      const buckets = bucketsFrom(usage);

      // A repeated sample for the same (turn, step) replaces the earlier one.
      const previous = state.last != null && state.last.turn === turn && state.last.step === step ? state.last : undefined;
      if (previous !== undefined && previous.model === bucketKey && previous.tier === tier && bucketsEqual(previous.buckets, buckets)) {
        return model === state.model ? state : { ...state, model };
      }

      const perModel = { ...state.perModel };
      // Remove the replaced sample from its original (model, tier) slot.
      if (previous !== undefined) {
        const prevEntry = { ...(perModel[previous.model] ?? { off: zeroBuckets(), peak: zeroBuckets() }) };
        prevEntry[previous.tier] = subBuckets(prevEntry[previous.tier], previous.buckets);
        perModel[previous.model] = prevEntry;
      }
      const entry = { ...(perModel[bucketKey] ?? { off: zeroBuckets(), peak: zeroBuckets() }) };
      entry[tier] = addBuckets(entry[tier], buckets);
      perModel[bucketKey] = entry;

      return { model, perModel, last: { turn, step, model: bucketKey, tier, buckets } };
    },
    wire: {
      viewSchema,
      view(state) {
        const totals = zeroBuckets();
        let cost = 0;
        for (const [bucketKey, entry] of Object.entries(state.perModel)) {
          const price = priceFor(prices, bucketKey);
          const off = entry.off ?? zeroBuckets();
          const peakBuckets = entry.peak ?? zeroBuckets();
          totals.uncachedInputTokens += off.uncachedInputTokens + peakBuckets.uncachedInputTokens;
          totals.outputTokens += off.outputTokens + peakBuckets.outputTokens;
          totals.cacheReadTokens += off.cacheReadTokens + peakBuckets.cacheReadTokens;
          totals.cacheWriteTokens += off.cacheWriteTokens + peakBuckets.cacheWriteTokens;
          cost += costOf(off, price) + costOf(peakBuckets, price) * multiplier;
        }
        return { currency, cost, model: state.model, currentTier: peak.isPeak(Date.now()) ? "peak" : "off", peakMultiplier: multiplier, ...totals };
      }
    },
    stateVersion: 2
  };
}

function warn(ctx, message) {
  try {
    if (ctx?.logger?.warn != null) ctx.logger.warn(`[dsh-cost-meter] ${message}`);
    else console.warn(`[dsh-cost-meter] ${message}`);
  } catch {
    console.warn(`[dsh-cost-meter] ${message}`);
  }
}

/**
 * Register the `costUsage` projection when the optional `sessionProjections`
 * registry is composed (always present on the Web surface).
 *
 * When `config.pricingUrl` is set, fetch it first (short timeout) and merge it
 * over the bundled defaults; any failure logs a warning and falls back.
 * @param ctx - host root context.
 * @param config - the raw plugin row config.
 */
async function apply(ctx, config) {
  const cfg = config ?? {};
  let fetched;
  if (typeof cfg.pricingUrl === "string" && cfg.pricingUrl !== "") {
    try {
      fetched = await loadPricingDocument(cfg.pricingUrl, cfg.pricingTimeoutMs ?? 4000);
    } catch (error) {
      warn(ctx, `could not load pricing from ${JSON.stringify(cfg.pricingUrl)}: ${error?.message ?? error}; using bundled defaults`);
    }
  }
  const prices = resolvePrices(cfg, fetched);
  const peak = resolvePeak(cfg);
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(buildProjection(prices, peak));
  });
}

export { apply, inject, name };
