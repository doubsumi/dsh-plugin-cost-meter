/**
 * Contract + pricing tests for `dsh-plugin-cost-meter`.
 *
 * These run without a live DSH and without network access: `apply()` is
 * called with `catalogUrl: ""` so only the bundled catalog and the explicit
 * config are used. `test` mocks the small slice of Cordis that `apply()`
 * touches.
 *
 * Run with: npm test   (or: node test/contract.test.mjs)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply, internals } from "../lib/index.js";

const { buildPriceTable, buildProjection, isPeakAt, lookupPrice, resolveSchedule } = internals;

/** Capture the projection definition that `apply()` registers. */
async function register(config = {}) {
  const captured = {};
  const ctx = {
    inject(_services, callback) {
      callback({ sessionProjections: { register(definition) { captured.definition = definition; return () => {}; } } });
      return () => {};
    },
    effect() {},
    logger: { warn() {} }
  };
  await apply(ctx, { catalogUrl: "", ...config });
  assert.ok(captured.definition, "apply() registered no projection");
  return captured.definition;
}

/** Fold events through the unit and return the schema-validated wire value. */
function fold(definition, events) {
  let state = definition.init();
  for (const event of events) state = definition.apply(state, event);
  const persisted = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  return definition.wire.viewSchema.parse(definition.wire.view(persisted));
}

/** Epoch ms for a Beijing (UTC+8) wall clock on a fixed date. */
function beijingEpoch(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month, day, hour - 8, minute, 0);
}

// 2026-01-05 is a Monday; 01-09 Friday; 01-10 Saturday; 01-11 Sunday.
const MON_10 = beijingEpoch(2026, 0, 5, 10);
const MON_20 = beijingEpoch(2026, 0, 5, 20);
const FRI_10 = beijingEpoch(2026, 0, 9, 10);
const SAT_10 = beijingEpoch(2026, 0, 10, 10);
const SUN_10 = beijingEpoch(2026, 0, 11, 10);

function usageEvent(time, { provider = "deepseek-official", model = "deepseek-flash", turn = 1, step = 1, usage } = {}) {
  return [
    { type: "request/header", time, data: { header: { config: { provider, model } } } },
    { type: "assistant/message", time, data: { turn, step, usage, message: {} } }
  ];
}

test("implements the DSH >= 0.1.5 projection contract", async () => {
  const definition = await register();
  assert.equal(definition.key, "costUsage");
  assert.equal(typeof definition.stateSchema?.parse, "function");
  assert.equal(typeof definition.wire?.viewSchema?.parse, "function");
  assert.equal(typeof definition.wire?.view, "function");
  assert.equal(definition.stateVersion, 4);
  assert.equal(definition.schema, undefined);
  assert.equal(definition.view, undefined);
});

test("peak hours apply on weekdays only (weekends are off-peak)", () => {
  const schedule = resolveSchedule({ timezoneOffsetMinutes: 480, windows: [[9, 12], [14, 18]] }, undefined);
  assert.equal(isPeakAt(MON_10, schedule), true, "Monday 10:00 must be peak");
  assert.equal(isPeakAt(FRI_10, schedule), true, "Friday 10:00 must be peak");
  assert.equal(isPeakAt(MON_20, schedule), false, "Monday 20:00 must be off-peak");
  assert.equal(isPeakAt(SAT_10, schedule), false, "Saturday 10:00 must be off-peak");
  assert.equal(isPeakAt(SUN_10, schedule), false, "Sunday 10:00 must be off-peak");
});

test("catalog schedules are parsed (UTC windows, weekday mask)", () => {
  const schedule = resolveSchedule({}, {
    timezone: "UTC",
    days: [1, 2, 3, 4, 5],
    windows: [{ from: "01:00", to: "04:00" }, { from: "06:00", to: "10:00" }],
    offPeakRatio: 0.5
  });
  assert.equal(schedule.timezoneOffsetMinutes, 0);
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(schedule.windows, [[1, 4], [6, 10]]);
  assert.equal(schedule.ratio, 0.5);
  // 02:00 UTC Monday is peak; 02:00 UTC Sunday is not.
  assert.equal(isPeakAt(Date.UTC(2026, 0, 5, 2), schedule), true);
  assert.equal(isPeakAt(Date.UTC(2026, 0, 4, 2), schedule), false);
});

test("explicit peak/off-peak catalog rates are used exactly", async () => {
  const definition = await register({ currency: "USD" });
  const value = fold(definition, [
    ...usageEvent(MON_10, { usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    ...usageEvent(MON_20, { turn: 2, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  ]);
  // deepseek-flash: 1M peak input * 0.3 + 1M off-peak input * 0.15 = 0.45 USD
  assert.ok(Math.abs(value.cost - 0.45) < 1e-9, `cost ${value.cost} != 0.45`);
  assert.equal(value.priced, true);
  assert.equal(value.currency, "USD");
});

test("a USD catalog is converted into the display currency", async () => {
  const definition = await register({ currency: "CNY", fx: { cnyPerUsd: 7.1 } });
  const value = fold(definition, usageEvent(MON_20, { usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
  // deepseek-flash off-peak 0.15 USD * 7.1 = 1.065 CNY
  assert.ok(Math.abs(value.cost - 1.065) < 1e-9, `cost ${value.cost} != 1.065`);
});

test("model and provider matching is case/space/punctuation insensitive", async () => {
  const definition = await register({ currency: "USD" });
  const value = fold(definition, usageEvent(MON_20, {
    provider: "DeepSeek-Official",
    model: "DeepSeek-Flash",
    usage: { inputTokens: 1_000_000, outputTokens: 0 }
  }));
  assert.equal(value.priced, true);
  assert.ok(Math.abs(value.cost - 0.15) < 1e-9, `cost ${value.cost} != 0.15`);
});

test("manual config overrides the catalog and accepts per-model wildcards", async () => {
  const definition = await register({
    currency: "CNY",
    models: {
      "*/deepseek-flash": { inputPerM: 1, outputPerM: 4 },
      "other/*": { inputPerM: 2, outputPerM: 8 }
    }
  });
  const flash = fold(definition, usageEvent(MON_20, {
    provider: "some-relay",
    model: "deepseek-flash",
    usage: { inputTokens: 1_000_000, outputTokens: 0 }
  }));
  assert.ok(Math.abs(flash.cost - 1) < 1e-9, `wildcard model cost ${flash.cost} != 1`);
  const other = fold(definition, usageEvent(MON_20, {
    provider: "other",
    model: "anything",
    usage: { inputTokens: 1_000_000, outputTokens: 0 }
  }));
  assert.ok(Math.abs(other.cost - 2) < 1e-9, `wildcard provider cost ${other.cost} != 2`);
});

test("manual config outranks the bundled catalog for the same route", async () => {
  const definition = await register({
    currency: "CNY",
    models: { "deepseek-flash": { inputPerM: 100, outputPerM: 400 } }
  });
  const value = fold(definition, usageEvent(MON_20, { usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
  assert.ok(Math.abs(value.cost - 100) < 1e-9, `manual override cost ${value.cost} != 100`);
});

test("an unpriced route is reported, not billed at a made-up rate", async () => {
  const definition = await register({ currency: "USD", models: {} });
  const value = fold(definition, usageEvent(MON_20, {
    provider: "mystery-provider",
    model: "no-such-model",
    usage: { inputTokens: 1_000_000, outputTokens: 0 }
  }));
  assert.equal(value.priced, false);
  assert.equal(value.cost, 0);
  assert.deepEqual(value.unpricedRoutes, ["mystery-provider/no-such-model"]);
  assert.equal(value.uncachedInputTokens, 1_000_000, "token totals still reported");
});

test("peak can be disabled to bill one flat rate", () => {
  const schedule = resolveSchedule({ enabled: false }, undefined);
  assert.equal(isPeakAt(MON_10, schedule), false);
});

test("lookup prefers a specific route over a wildcard", () => {
  const schedule = resolveSchedule({}, undefined);
  const table = buildPriceTable({
    bundled: {
      currency: "USD",
      providers: {
        "deepseek-official": {
          models: {
            "*": { cacheMiss: 9, output: 9 },
            "deepseek-flash": { cacheMiss: 0.3, output: 1.2 }
          }
        }
      }
    },
    config: {},
    schedule
  });
  const matched = lookupPrice(table, "deepseek-official", "deepseek-flash");
  assert.equal(matched.model, "deepseek-flash");
  assert.equal(matched.rates.peak.miss, 0.3);
});

test("a remote catalog's peak schedule overrides the bundled snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-cost-meter-"));
  const file = join(directory, "prices.json");
  writeFileSync(file, JSON.stringify({
    schema: 1,
    currency: "USD",
    providers: {
      "deepseek-official": {
        // Deliberately different from the bundled schedule (which also has 01:00-04:00).
        peakSchedule: { timezone: "UTC", days: [1, 2, 3, 4, 5], windows: [{ from: "06:00", to: "10:00" }], offPeakRatio: 0.5 },
        models: { "deepseek-flash": { cacheMiss: 0.3, output: 1.2 } }
      }
    }
  }));

  const definition = await register({ currency: "USD", catalogUrl: pathToFileURL(file).href });
  // 02:00 UTC Monday is peak under the bundled schedule but off-peak under the remote one.
  const value = fold(definition, usageEvent(Date.UTC(2026, 0, 5, 2), {
    usage: { inputTokens: 1_000_000, outputTokens: 0 }
  }));
  assert.ok(Math.abs(value.cost - 0.15) < 1e-9, `cost ${value.cost} != 0.15 (remote schedule not applied)`);
});

test("a later price update never re-prices already counted samples", () => {
  const schedule = resolveSchedule({}, undefined);
  const catalog = (miss) => ({ currency: "USD", providers: { acme: { models: { "model-a": { cacheMiss: miss, output: 0 } } } } });
  const firstTable = buildPriceTable({ bundled: catalog(1), config: {}, schedule });
  const newTable = buildPriceTable({ bundled: catalog(5), config: {}, schedule });
  const live = { current: { table: firstTable, schedule } };
  const definition = buildProjection(live);
  const parse = (state) => definition.wire.viewSchema.parse(definition.wire.view(definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))));

  const header = { type: "request/header", time: MON_10, data: { header: { config: { provider: "acme", model: "model-a" } } } };
  const usage = (turn) => ({ type: "assistant/message", time: MON_10, data: { turn, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: {} } });

  let state = definition.init();
  state = definition.apply(state, header);
  state = definition.apply(state, usage(1));
  const before = parse(state);
  assert.ok(Math.abs(before.cost - 1) < 1e-9, `first cost ${before.cost} != 1`);

  // A silent price refresh swaps the live table.
  live.current = { table: newTable, schedule };

  const after = parse(state);
  assert.ok(Math.abs(after.cost - 1) < 1e-9, `history was re-priced to ${after.cost}`);

  // Only the next sample uses the new price.
  state = definition.apply(state, header);
  state = definition.apply(state, usage(2));
  const next = parse(state);
  assert.ok(Math.abs(next.cost - 6) < 1e-9, `cost ${next.cost} != 6 (1 frozen + 5 at the new price)`);
});

test("replacing a sample subtracts its frozen amount exactly", () => {
  const schedule = resolveSchedule({}, undefined);
  const table = buildPriceTable({ bundled: { currency: "USD", providers: { acme: { models: { "model-a": { cacheMiss: 1, output: 0 } } } } }, config: {}, schedule });
  const definition = buildProjection({ current: { table, schedule } });
  const parse = (state) => definition.wire.viewSchema.parse(definition.wire.view(definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))));

  let state = definition.init();
  state = definition.apply(state, { type: "request/header", time: MON_10, data: { header: { config: { provider: "acme", model: "model-a" } } } });
  state = definition.apply(state, { type: "assistant/chunk", time: MON_10, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } } } });
  assert.ok(Math.abs(parse(state).cost - 1) < 1e-9);
  state = definition.apply(state, { type: "assistant/message", time: MON_10, data: { turn: 1, step: 1, usage: { inputTokens: 2_000_000, outputTokens: 0 }, message: {} } });
  const value = parse(state);
  assert.ok(Math.abs(value.cost - 2) < 1e-9, `cost ${value.cost} != 2 (the 1M chunk must be replaced, not added)`);
  assert.equal(value.uncachedInputTokens, 2_000_000);
});
