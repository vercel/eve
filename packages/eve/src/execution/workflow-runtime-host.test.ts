import { describe, expect, it } from "vitest";

import { installedDurableHost } from "#execution/hosts.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";

describe("the Workflow runtime", () => {
  it("installs Workflow as the realm's durable host", () => {
    expect(installedDurableHost()).toBeUndefined();
    createWorkflowRuntime({ compiledArtifactsSource: {} as never });
    expect(installedDurableHost()?.name).toBe("workflow");
  });
});
