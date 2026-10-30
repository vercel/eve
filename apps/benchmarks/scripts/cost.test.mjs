import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countToolInvocations,
  extractRunRequests,
  extractRunUsage,
  modelPricing,
  priceRequests,
  priceUsage,
  tokenConsumption,
} from "./cost.mjs";
import { benchmarkModels } from "../lib/benchmark-config.ts";

test("extracts usage from authoring harness transcripts", () => {
  const usage = extractRunUsage(
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Hi" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            cachedInputTokens: 50,
            cacheWriteTokens: 10,
          },
        },
      }),
    ].join("\n"),
  );

  assert.deepEqual(usage, {
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 50,
    cacheWrite: 10,
  });
});

test("extracts OpenCode step usage", () => {
  const usage = extractRunUsage(
    JSON.stringify({
      type: "step_finish",
      part: {
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } },
      },
    }),
    "OpenCode",
  );

  assert.deepEqual(usage, { input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 10 });
});

test("extracts Claude Code message usage", () => {
  const usage = extractRunUsage(
    JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      },
    }),
    "Claude Code",
  );

  assert.deepEqual(usage, { input: 100, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 10 });
});

test("extracts Codex completion usage without double-counting cached input", () => {
  const usage = extractRunUsage(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 150,
        cached_input_tokens: 50,
        cache_write_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    }),
    "Codex",
  );

  assert.deepEqual(usage, { input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 10 });
});

test("calculates token consumption without double-counting cache details", () => {
  assert.equal(
    tokenConsumption({
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 50,
      cacheWrite: 10,
    }),
    125,
  );
});

test("counts native OpenCode and Codex tool invocations", () => {
  const raw = [
    JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
  ].join("\n");

  assert.equal(countToolInvocations(raw), 2);
});

test("counts tool invocations in authoring harness transcripts", () => {
  const raw = [
    JSON.stringify({ type: "user", message: { role: "user", content: "Hi" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", name: "read", input: {} },
          { type: "tool_use", name: "bash", input: {} },
        ],
      },
    }),
  ].join("\n");

  assert.equal(countToolInvocations(raw), 2);
});

test("prices reasoning at the output rate", () => {
  assert.equal(
    priceUsage(
      { input: 100_000, output: 20_000, reasoning: 5_000, cacheRead: 50_000, cacheWrite: 10_000 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    ),
    0.7275,
  );
});

test("counts a Claude Code response once, however many content-block events repeat its usage", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1_000 };
  const raw = [
    { type: "assistant", message: { id: "msg_1", content: [{ type: "text" }], usage } },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use" }], usage } },
    { type: "user", message: { content: [{ type: "tool_result" }] } },
    { type: "assistant", message: { id: "msg_2", content: [{ type: "text" }], usage } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  assert.equal(extractRunRequests(raw, "Claude Code").length, 2);
  assert.deepEqual(extractRunUsage(raw, "Claude Code"), {
    input: 20,
    output: 10,
    reasoning: 0,
    cacheRead: 2_000,
    cacheWrite: 0,
  });
});

test("prices each request at long-context rates when its prompt exceeds the threshold", () => {
  const pricing = modelPricing["anthropic/claude-haiku-5.5"];
  const short = { input: 1_000, output: 1_000, reasoning: 0, cacheRead: 99_000, cacheWrite: 0 };
  const long = { input: 1_000, output: 1_000, reasoning: 0, cacheRead: 99_001, cacheWrite: 0 };
  // Short: 1k × $0.10 + 1k × $0.50 + 99k × $0.01 per 1M; long: the same tokens at 5×.
  assert.ok(Math.abs(priceRequests([short], pricing) - 0.00159) < 1e-12);
  assert.ok(Math.abs(priceRequests([long], pricing) - 0.00795005) < 1e-12);
  assert.ok(Math.abs(priceRequests([short, long], pricing) - (0.00159 + 0.00795005)) < 1e-12);
  assert.equal(priceRequests([], pricing), null);
});

test("refuses long-context pricing for Codex's per-turn usage", () => {
  const pricing = modelPricing["anthropic/claude-haiku-5.5"];
  const turn = { input: 1_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  assert.throws(() => priceRequests([turn], pricing, "Codex"), /per-request usage/u);
  for (const benchmark of benchmarkModels.filter((entry) => entry.harness === "Codex")) {
    assert.equal(modelPricing[benchmark.model]?.longContext, undefined, benchmark.id);
  }
});
