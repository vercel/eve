import assert from "node:assert/strict";
import { test } from "node:test";

import { findBenchmarkModel, findPublishedBenchmarkModel, harnessId } from "./benchmark-config.ts";

test("selects qualified Gateway IDs and explicit reasoning settings for publication", () => {
  assert.equal(findPublishedBenchmarkModel("grok-4-7").model, "spacexai/grok-4.7");
  assert.equal(findPublishedBenchmarkModel("glm-5-3").model, "zai/glm-5.3");
  for (const [id, model] of [
    ["gpt-6-sol-high", "openai/gpt-6-sol"],
    ["gpt-6-luna-high", "openai/gpt-6-luna"],
    ["gpt-6-astra-high", "openai/gpt-6-astra"],
  ]) {
    const benchmark = findPublishedBenchmarkModel(id);
    assert.equal(benchmark.agentModel, `${model}?reasoningEffort=high`);
    assert.equal(harnessId(benchmark.harness), "codex");
  }
  for (const id of ["claude-opus-5-5-high", "claude-fable-5-1"]) {
    const benchmark = findPublishedBenchmarkModel(id);
    assert.equal(benchmark.agentOptions.effort, "high");
    assert.equal(harnessId(benchmark.harness), "claude-code");
  }
});

test("allows local retired probes without admitting them to publication", () => {
  assert.equal(findBenchmarkModel("grok-4-6").support, "superseded");
  assert.equal(findBenchmarkModel("glm-5-2").support, "superseded");
  for (const id of ["grok-4-6", "glm-5-2"]) {
    assert.throws(() => findPublishedBenchmarkModel(id), /not in the supported publication set/u);
  }
  assert.throws(() => findBenchmarkModel("unknown"), /Unknown model/u);
});
