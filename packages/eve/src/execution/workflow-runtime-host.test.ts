import { describe, expect, it } from "vitest";

import { installedDurableHost } from "#execution/hosts.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";

// Routes and channels that start sessions on Workflow create this runtime first. Without the
// durable host it installs, the hooks and runs no route holds would have nowhere to go.
describe("the Workflow runtime", () => {
  it("installs Workflow as the realm's durable host", () => {
    expect(installedDurableHost()).toBeUndefined();
    createWorkflowRuntime({ compiledArtifactsSource: {} as never });
    expect(installedDurableHost()?.name).toBe("workflow");
  });
});
