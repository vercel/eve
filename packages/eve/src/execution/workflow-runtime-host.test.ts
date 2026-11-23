import { describe, expect, it } from "vitest";

import { installedProcessEngine } from "#execution/hosts.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";

describe("the Workflow runtime", () => {
  it("installs Workflow as the realm's durable engine", () => {
    expect(installedProcessEngine()).toBeUndefined();
    createWorkflowRuntime({ compiledArtifactsSource: {} as never });
    expect(installedProcessEngine()?.name).toBe("workflow");
  });
});
