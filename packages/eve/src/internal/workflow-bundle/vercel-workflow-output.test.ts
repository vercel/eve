import { describe, expect, it } from "vitest";

import { createWorkflowFunctionEnvironment } from "#internal/workflow-bundle/vercel-workflow-output.js";

describe("createWorkflowFunctionEnvironment", () => {
  it("omits the public route prefix when the build input does not carry one", () => {
    expect(createWorkflowFunctionEnvironment()).not.toHaveProperty("EVE_PUBLIC_ROUTE_PREFIX");
    expect(createWorkflowFunctionEnvironment({ publicRoutePrefix: "" })).not.toHaveProperty(
      "EVE_PUBLIC_ROUTE_PREFIX",
    );
  });

  it("bakes the normalized public route prefix from the build input", () => {
    expect(
      createWorkflowFunctionEnvironment({
        environment: { EXISTING: "1" },
        publicRoutePrefix: "eve/agents/support/",
      }),
    ).toMatchObject({
      EVE_PUBLIC_ROUTE_PREFIX: "/eve/agents/support",
      EXISTING: "1",
    });
  });
});
