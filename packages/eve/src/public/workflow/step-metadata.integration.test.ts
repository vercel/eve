import { expect, it } from "vitest";

import { stepMetadataWorkflow } from "#internal/testing/step-metadata-workflow.js";
import { start } from "#internal/workflow/runtime.js";

it("getStepMetadata from eve/workflow reads each attempt of a retried step under one stepId", async () => {
  const run = await start(stepMetadataWorkflow, []);
  const [first, second] = await run.returnValue;

  expect(first).toEqual({ stepId: expect.any(String), attempt: 1, maxAttempts: 3 });
  expect(second).toEqual({ stepId: first?.stepId, attempt: 2, maxAttempts: 3 });
}, 60_000);
