import { describe, expect, it } from "vitest";

import { availableApprovalGrants } from "./evaluation.js";

describe("remembered approval availability", () => {
  it("withholds a tool's grant while an independent grant-bearing approval remains open", () => {
    const grants = [
      { toolName: "deploy", interactionId: "approved-deploy" },
      { toolName: "publish", interactionId: "approved-publish" },
    ];
    const pending = [
      { grantOnAcceptance: { toolName: "deploy" } },
      { grantOnAcceptance: undefined },
    ];

    expect(availableApprovalGrants(grants, pending)).toEqual([
      { toolName: "publish", interactionId: "approved-publish" },
    ]);
    expect(availableApprovalGrants(grants, [])).toEqual(grants);
  });
});
