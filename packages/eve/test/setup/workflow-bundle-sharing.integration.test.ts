import { expect, it } from "vitest";

import { catchWorkflowError } from "#internal/testing/workflow-api-workflows.js";
import { getWorld, start } from "#internal/workflow/runtime.js";

/**
 * The step registrations bundle loads natively, outside the module graph the tests import (see
 * `vitest.integration.config.ts`), and the entrypoint is built from the build's driver code with
 * the runtime this module graph imported. A delivery only completes if the driver runs on the
 * World installed for the tests and finds the steps the bundle registered, so this pins both.
 */
it("serves a delivery from the runtime and steps this module graph loaded", async () => {
  await expect(getWorld()).resolves.toBeDefined();

  const run = await start(catchWorkflowError, ["fatal"]);
  await expect(run.returnValue).resolves.toEqual({
    fatal: true,
    retryable: false,
    retryAfter: null,
  });

  // The step registry is a global the workflow runtime and every bundle of it share.
  const registeredSteps = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@workflow/core//registeredSteps")
  ] as Map<string, unknown>;
  expect([...registeredSteps.keys()]).toContain(
    "step//./src/internal/testing/workflow-api-workflows//failStep",
  );
});
