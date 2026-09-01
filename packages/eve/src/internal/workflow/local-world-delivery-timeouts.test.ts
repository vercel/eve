import { describe, expect, it } from "vitest";

import { applyLocalWorkflowWorldDeliveryTimeoutDefaults } from "#internal/workflow/local-world-delivery-timeouts.js";

describe("applyLocalWorkflowWorldDeliveryTimeoutDefaults", () => {
  it("defaults unset and empty local delivery timeouts to unbounded", () => {
    const env: Record<string, string | undefined> = {
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "",
    };

    applyLocalWorkflowWorldDeliveryTimeoutDefaults(env);

    expect(env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS).toBe("0");
    expect(env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS).toBe("0");
  });

  it("preserves explicit local delivery timeouts", () => {
    const env: Record<string, string | undefined> = {
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "123",
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "456",
    };

    applyLocalWorkflowWorldDeliveryTimeoutDefaults(env);

    expect(env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS).toBe("123");
    expect(env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS).toBe("456");
  });
});
