/**
 * Contract tests for the `costUsage` projection.
 *
 * These run without a live DSH: they mock the tiny slice of Cordis that
 * `apply()` touches (ctx.inject + sessionProjections.register) and drive the
 * projection with synthetic session events shaped like the real log.
 *
 * Run with: npm test   (or: node test/contract.test.mjs)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/** Capture the projection definition that `apply()` registers. */
function register(config) {
  const captured = {};
  const ctx = {
    inject(_services, callback) {
      callback({
        sessionProjections: {
          register(definition) {
            captured.definition = definition;
            return () => {};
          }
        }
      });
      return () => {};
    },
    logger: { warn() {} }
  };
  return apply(ctx, config).then(() => {
    assert.ok(captured.definition, "apply() registered no projection");
    return captured.definition;
  });
}

/** Fold events through the unit and return the schema-validated wire value. */
function fold(definition, events) {
  let state = definition.init();
  for (const event of events) state = definition.apply(state, event);
  const persisted = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  return definition.wire.viewSchema.parse(definition.wire.view(persisted));
}

/** Epoch ms for a Beijing (UTC+8) wall clock on a fixed day. */
function beijing(hour, minute = 0) {
  const utcHour = hour - 8;
  const dayOffset = Math.floor(utcHour / 24);
  const hh = ((utcHour % 24) + 24) % 24;
  return Date.UTC(2025, 0, 15 + dayOffset, hh, minute, 0);
}

const PRICES = {
  models: {
    "deepseek-flash": { inputPerM: 1.5, cacheReadPerM: 0.05, cacheWritePerM: 1.5, outputPerM: 4.5 },
    "deepseek-v4-pro": { inputPerM: 4.5, cacheReadPerM: 0.15, cacheWritePerM: 4.5, outputPerM: 13.5 }
  }
};

test("implements the DSH >= 0.1.5 projection contract", async () => {
  const definition = await register({});
  assert.equal(definition.key, "costUsage");
  assert.equal(typeof definition.stateSchema?.parse, "function");
  assert.equal(typeof definition.wire?.viewSchema?.parse, "function");
  assert.equal(typeof definition.wire?.view, "function");
  assert.ok(Number.isSafeInteger(definition.stateVersion) && definition.stateVersion >= 0);
  // The pre-0.1.5 shape must be gone: a `view` without `wire` registers host-only.
  assert.equal(definition.schema, undefined);
  assert.equal(definition.view, undefined);
});

test("prices each request by its own peak/off-peak wall clock", async () => {
  const definition = await register(PRICES);
  const value = fold(definition, [
    { type: "request/header", time: beijing(8), data: { header: { config: { model: "deepseek-v4-pro" } } } },
    { type: "assistant/chunk", time: beijing(8), data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 100 } } } },
    // A finalized message for the same step replaces the early chunk sample.
    { type: "assistant/message", time: beijing(8), data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 200 }, message: {} } },
    { type: "request/header", time: beijing(10), data: { header: { config: { model: "deepseek-flash" } } } },
    { type: "assistant/message", time: beijing(10), data: { turn: 1, step: 2, usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: {} } }
  ]);

  // pro off-peak: 1M * 4.5 + 200 * 13.5/1e6 ; flash peak: 1M * 1.5 * 2
  const expected = (1_000_000 * 4.5 + 200 * 13.5) / 1e6 + (1_000_000 * 1.5 * 2) / 1e6;
  assert.ok(Math.abs(value.cost - expected) < 1e-9, `cost ${value.cost} != ${expected}`);
  assert.equal(value.outputTokens, 200, "chunk->message dedup failed");
  assert.equal(value.uncachedInputTokens, 2_000_000);
  assert.equal(value.model, "deepseek-flash");
  assert.equal(value.peakMultiplier, 2);
});

test("peak can be disabled to bill a single flat rate", async () => {
  const definition = await register({ ...PRICES, peak: { enabled: false } });
  const value = fold(definition, [
    { type: "request/header", time: beijing(8), data: { header: { config: { model: "deepseek-flash" } } } },
    { type: "assistant/message", time: beijing(8), data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: {} } },
    { type: "assistant/message", time: beijing(10), data: { turn: 1, step: 2, usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: {} } }
  ]);
  // Both billed at the off-peak rate: 1M * 1.5 * 2 = 3
  assert.ok(Math.abs(value.cost - 3) < 1e-9, `cost ${value.cost} != 3`);
});

test("an unknown model falls back to the default price", async () => {
  const definition = await register({ default: { inputPerM: 1, outputPerM: 4 } });
  const value = fold(definition, [
    { type: "request/header", time: beijing(8), data: { header: { config: { model: "some-new-model" } } } },
    { type: "assistant/message", time: beijing(8), data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: {} } }
  ]);
  assert.ok(Math.abs(value.cost - 1) < 1e-9, `cost ${value.cost} != 1`);
});
