import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findBenchmarkModel,
  findPublishedBenchmarkModel,
  publishedBenchmark,
  publishedBenchmarkModels,
} from "./benchmark-config.ts";

test("publishes only compatibility-validated models", () => {
  assert.deepEqual(
    publishedBenchmarkModels.map((benchmark) => benchmark.id),
    [
      "kimi-k3",
      "claude-fable-5",
      "grok-4-6",
      "gpt-5-6-sol",
      "gpt-5-6-terra",
      "claude-sonnet-5",
      "glm-5-2",
      "gemini-3-1-pro-preview",
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
  assert.equal(findPublishedBenchmarkModel("grok-4-6").model, "xai/grok-4.6");
  assert.equal(findPublishedBenchmarkModel("claude-sonnet-5").model, "anthropic/claude-sonnet-5");
  assert.equal(findPublishedBenchmarkModel("glm-5-2").model, "zai/glm-5.2");
});

test("allows candidate probes and rejects unknown models", () => {
  assert.equal(findBenchmarkModel("gpt-5-6-sol").support, "supported");
  assert.equal(findBenchmarkModel("gpt-5-6-terra").support, "supported");
  assert.equal(findBenchmarkModel("grok-4-6").support, "supported");
  assert.equal(findBenchmarkModel("claude-sonnet-4-6").support, "superseded");
  assert.equal(findBenchmarkModel("claude-opus-5").support, "candidate");
  assert.throws(() => findBenchmarkModel("unknown"), /Unknown model/u);
});
