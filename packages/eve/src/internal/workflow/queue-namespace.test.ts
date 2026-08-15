import { describe, expect, it, vi } from "vitest";

import {
  deriveEveWorkflowQueueNamespace,
  deriveEveWorkflowQueuePrefix,
  deriveEveWorkflowQueueTopic,
  installEveWorkflowQueueNamespace,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";

describe("workflow queue namespace", () => {
  it("derives a valid, collision-free namespace from the agent name", () => {
    expect(deriveEveWorkflowQueueNamespace("weather-agent")).toBe("eve776561746865722d6167656e74");
    expect(deriveEveWorkflowQueueNamespace("weatheragent")).not.toBe(
      deriveEveWorkflowQueueNamespace("weather-agent"),
    );
    expect(deriveEveWorkflowQueueNamespace("weather-agent")).toMatch(/^[a-z][a-z0-9]*$/);
  });

  it("derives the workflow queue prefix and topic from the same namespace", () => {
    expect(deriveEveWorkflowQueuePrefix("weather-agent")).toBe(
      "__eve776561746865722d6167656e74_wkf_workflow_",
    );
    expect(deriveEveWorkflowQueueTopic("weather-agent")).toBe(
      "__eve776561746865722d6167656e74_wkf_workflow_*",
    );
  });

  it("installs the derived namespace for Workflow runtime operations", () => {
    vi.stubEnv(WORKFLOW_QUEUE_NAMESPACE_ENV, "previous");

    try {
      expect(installEveWorkflowQueueNamespace("weather-agent")).toBe(
        "eve776561746865722d6167656e74",
      );
      expect(process.env[WORKFLOW_QUEUE_NAMESPACE_ENV]).toBe("eve776561746865722d6167656e74");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
