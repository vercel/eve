import { expect, it } from "vitest";

import { sessionLineStore } from "#execution/hosts.js";
import { stepRetryHostWorkflow } from "#internal/testing/step-retry-host-workflow.js";
import { start } from "#internal/workflow/runtime.js";

// Workflow runs a step by its id and hands it nothing but its input, so eve's step code reads
// the attempt from the host installed in its realm. A step bundle that ran eve's steps without
// installing Workflow's host would read every retry as a first attempt, and a retried step would
// skip repairing what its interrupted attempt wrote. This realm creates no Workflow runtime, so
// the step bundle's builtins are the only thing that can install it.

it("a Workflow step bundle installs Workflow's host with its steps, so a retry reads as one", async () => {
  expect(() => sessionLineStore("session-alice")).toThrow(
    'No host in this realm holds session "session-alice".',
  );
  const run = await start(stepRetryHostWorkflow, []);
  await expect(run.returnValue).resolves.toEqual({ attempt: 2, retried: true });
  expect(() => sessionLineStore("session-alice")).not.toThrow();
}, 60_000);
