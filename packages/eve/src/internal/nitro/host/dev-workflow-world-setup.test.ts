import { afterEach, describe, expect, it, vi } from "vitest";

import { installWorkflowTransportEnvironment } from "#internal/nitro/host/dev-workflow-world-setup.js";

const SESSION_SECRET = "development-transport-secret-0123456789";

describe("installWorkflowTransportEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives the session a delivery secret only when the developer set none", () => {
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", undefined);
    const restore = installWorkflowTransportEnvironment("/app", SESSION_SECRET);
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toMatch(/^[a-f0-9]{64}$/);
    restore();
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBeUndefined();

    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", "developer-chosen-delivery-secret-0123456789");
    const restoreConfigured = installWorkflowTransportEnvironment("/app", SESSION_SECRET);
    try {
      expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBe(
        "developer-chosen-delivery-secret-0123456789",
      );
    } finally {
      restoreConfigured();
    }
  });
});
