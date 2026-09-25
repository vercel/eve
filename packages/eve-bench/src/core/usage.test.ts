import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLI_USAGE, readCliUsage } from "../harnesses/cli/usage.ts";
import { eveStepUsage, readEveUsage } from "../harnesses/eve/usage.ts";
import { readJsonlUsage } from "./usage.ts";

// Shapes below are copied from recorded native logs (pi 0.85.1, opencode, eve 0.35).
const piAssistant = (input: number, cacheRead: number, output: number, total = 0) => ({
  type: "message_end",
  message: {
    role: "assistant",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { total },
    },
    stopReason: "toolUse",
  },
});

test("pi usage sums assistant message_end records and adds cache reads to input", () => {
  assert.equal(
    CLI_USAGE.pi({ type: "message_end", message: { role: "user", usage: null } }),
    undefined,
  );
  assert.equal(CLI_USAGE.pi({ type: "agent_end", messages: [] }), undefined);
  assert.deepEqual(CLI_USAGE.pi(piAssistant(100, 900, 50, 0.01)), {
    input: 1000,
    output: 50,
    cached: 900,
    cost: 0.01,
  });
});

test("opencode usage counts reasoning as output and cache reads as input", () => {
  const stepFinish = {
    type: "step_finish",
    part: {
      type: "step-finish",
      reason: "tool-calls",
      tokens: {
        total: 8542,
        input: 8154,
        output: 33,
        reasoning: 355,
        cache: { write: 0, read: 12 },
      },
      cost: 0,
    },
  };
  assert.deepEqual(CLI_USAGE.opencode(stepFinish), {
    input: 8166,
    output: 388,
    cached: 12,
    cost: 0,
  });
  assert.equal(CLI_USAGE.opencode({ type: "text", part: {} }), undefined);
});

test("codex usage reads turn.completed totals", () => {
  assert.deepEqual(
    CLI_USAGE.codex({
      type: "turn.completed",
      usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
    }),
    { input: 24763, output: 122, cached: 24448 },
  );
  assert.equal(CLI_USAGE.codex({ type: "turn.failed", error: { message: "401" } }), undefined);
});

test("eve usage reads step.completed usage", () => {
  assert.deepEqual(
    eveStepUsage({
      type: "step.completed",
      data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, costUsd: 0.5 } },
    }),
    { input: 10, output: 2, cached: 4, cost: 0.5 },
  );
  assert.equal(eveStepUsage({ type: "step.started", data: { modelId: "x" } }), undefined);
});

test("log readers skip diagnostics, report missing logs, and mark zero cost unknown", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "eve-bench-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await readCliUsage("pi", dir), undefined);

  // A 401 still emits an assistant message_end, so usage exists but is zero.
  await writeFile(
    join(dir, "pi.jsonl"),
    ["native warning: not json", JSON.stringify(piAssistant(0, 0, 0)), "{truncated", ""].join("\n"),
  );
  assert.deepEqual(await readCliUsage("pi", dir), {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: null,
  });

  await writeFile(
    join(dir, "events.ndjson"),
    `${JSON.stringify({ type: "session.started" })}\n${JSON.stringify({
      type: "step.completed",
      data: { usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.25 } },
    })}\n${JSON.stringify({ type: "step.completed", data: { usage: { inputTokens: 5, outputTokens: 1 } } })}\n`,
  );
  assert.deepEqual(await readEveUsage(dir), {
    inputTokens: 12,
    outputTokens: 4,
    cachedTokens: 0,
    costUsd: 0.25,
  });

  await writeFile(join(dir, "empty.jsonl"), `${JSON.stringify({ type: "session.started" })}\n`);
  assert.equal(await readJsonlUsage(join(dir, "empty.jsonl"), eveStepUsage), undefined);
});
