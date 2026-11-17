import { expect, it } from "vitest";

import { catchWorkflowError } from "#internal/testing/workflow-api-workflows.js";
import { getWorld, start } from "#internal/workflow/runtime.js";

it("serves a delivery from the runtime and steps this module graph loaded", async () => {
  await expect(getWorld()).resolves.toBeDefined();

  const run = await start(catchWorkflowError, ["fatal"]);
  await expect(run.returnValue).resolves.toEqual({
    fatal: true,
    retryable: false,
    retryAfter: null,
  });

  const registeredSteps = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@workflow/core//registeredSteps")
  ] as Map<string, unknown>;
  expect([...registeredSteps.keys()]).toContain(
    "step//./src/internal/testing/workflow-api-workflows//failStep",
  );
});
