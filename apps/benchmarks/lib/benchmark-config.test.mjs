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
      "claude-sonnet-4-6",
      "kimi-k3",
      "claude-fable-5",
      "gpt-5-6-sol",
      "gpt-5-6-terra",
      "gemini-3-1-pro-preview",
    ],
  );
  assert.deepEqual(publishedBenchmark.caseIds, [
    "author-001-weather-tool",
    "author-002-new-project",
  ]);
  assert.throws(
    () => findPublishedBenchmarkModel("grok-4-6"),
    /not in the supported publication set/u,
  );
});

test("allows candidate probes and rejects unknown models", () => {
  assert.equal(findBenchmarkModel("gpt-5-6-sol").support, "supported");
  assert.equal(findBenchmarkModel("gpt-5-6-terra").support, "supported");
  assert.equal(findBenchmarkModel("grok-4-6").support, "candidate");
  assert.throws(() => findBenchmarkModel("unknown"), /Unknown model/u);
});
