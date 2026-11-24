import { builtInHosts } from "#runtime/app.js";
import { expect, it } from "vitest";

import { sessionEventStore } from "#execution/hosts.js";
import { stepRetryHostWorkflow } from "#internal/testing/step-retry-host-workflow.js";
import { start } from "#internal/workflow/runtime.js";

it("a Workflow step bundle installs Workflow's host with its steps, so a retry reads as one", async () => {
  expect(() => sessionEventStore(builtInHosts(), "session-alice")).toThrow(
    'No host in this realm holds session "session-alice".',
  );
  const run = await start(stepRetryHostWorkflow, []);
  await expect(run.returnValue).resolves.toEqual({ attempt: 2, retried: true });
  expect(() => sessionEventStore(builtInHosts(), "session-alice")).not.toThrow();
}, 60_000);
