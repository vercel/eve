import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findBenchmarkModel,
  findPublishedBenchmarkModel,
  harnessId,
  publishedBenchmark,
  publishedBenchmarkModels,
} from "./benchmark-config.ts";

test("publishes only compatibility-validated models", () => {
  assert.deepEqual(
    publishedBenchmarkModels.map((benchmark) => benchmark.id),
    [
      "kimi-k3",
      "claude-fable-5-1",
      "grok-4-7",
      "gpt-5-6-sol",
      "gpt-5-6-terra",
      "gpt-6-astra-high",
      "claude-sonnet-5",
      "glm-5-3",
      "claude-opus-5",
      "gemini-3-1-pro-preview",
      "gemini-3-8-flash",
      "minimax-m3",
      "kimi-k2-7-code",
    ],
  );
  assert.deepEqual(publishedBenchmark.caseIds, [
    "author-001-weather-tool",
    "author-002-new-project",
    "author-003-openapi-connection",
    "author-004-packaged-skill",
    "author-005-conditional-approval",
    "author-006-custom-channel",
    "author-007-digest-schedule",
  ]);
  assert.equal(findPublishedBenchmarkModel("grok-4-7").model, "spacexai/grok-4.7");
  assert.equal(findPublishedBenchmarkModel("claude-sonnet-5").model, "anthropic/claude-sonnet-5");
  assert.equal(findPublishedBenchmarkModel("glm-5-3").model, "zai/glm-5.3");
  assert.equal(
    findPublishedBenchmarkModel("gpt-6-astra-high").agentModel,
    "openai/gpt-6-astra?reasoningEffort=high",
  );
  assert.equal(findPublishedBenchmarkModel("claude-fable-5-1").harness, "Claude Code");
  assert.equal(findPublishedBenchmarkModel("claude-sonnet-5").harness, "Claude Code");
  assert.equal(findPublishedBenchmarkModel("claude-opus-5").harness, "Claude Code");
  assert.equal(findPublishedBenchmarkModel("kimi-k3").harness, "OpenCode");
  assert.equal(findPublishedBenchmarkModel("gpt-5-6-sol").harness, "Codex");
  assert.equal(findPublishedBenchmarkModel("gpt-5-6-terra").harness, "Codex");
  assert.equal(harnessId("Codex"), "codex");
});

test("allows candidate probes and rejects unknown models", () => {
  assert.equal(findBenchmarkModel("gpt-5-6-sol").support, "supported");
  assert.equal(findBenchmarkModel("gpt-5-6-terra").support, "supported");
  assert.equal(findBenchmarkModel("gpt-6-astra-high").support, "supported");
  assert.equal(findBenchmarkModel("gemini-3-8-flash").support, "supported");
  assert.equal(findBenchmarkModel("minimax-m3").support, "supported");
  assert.equal(findBenchmarkModel("kimi-k2-7-code").support, "supported");
  assert.equal(findBenchmarkModel("grok-4-7").support, "supported");
  assert.equal(findBenchmarkModel("claude-sonnet-4-6").support, "superseded");
  assert.equal(findBenchmarkModel("claude-fable-5").support, "superseded");
  assert.equal(findBenchmarkModel("glm-5-2").support, "superseded");
  assert.equal(findBenchmarkModel("claude-opus-5").support, "supported");
  assert.throws(() => findBenchmarkModel("unknown"), /Unknown model/u);
});
