import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalResponseContext,
} from "#public/definitions/approval.js";

describe("approval definitions", () => {
  it("preserves request-time function shorthand", async () => {
    const policy: Approval = () => "user-approval";

    expect(await resolveApprovalPolicy(policy)({} as never)).toBe("user-approval");
  });

  it("resolves request policy from the object form", async () => {
    const policy = vi.fn(() => "not-applicable" as const);
    const approval: Approval = {
      request: policy,
      response: () => ({ status: "allowed" }),
    };

    expect(await resolveApprovalPolicy(approval)({} as never)).toBe("not-applicable");
    expect(policy).toHaveBeenCalledOnce();
  });

  it("keeps response authorization context capability narrow", () => {
    expectTypeOf<ApprovalResponseContext>().toMatchTypeOf<{
      auth: {
        getToken: (...args: any[]) => Promise<unknown>;
        requireAuth: (...args: any[]) => never;
      };
      request: { callId: string; requestId: string; toolName: string };
      response: { decision: "approve" };
      responder: { principalId: string };
      session: { id: string; initiator: unknown; turn: unknown };
    }>();
    expectTypeOf<ApprovalResponseContext["auth"]>().not.toHaveProperty("getSandbox");
    expectTypeOf<ApprovalResponseContext["auth"]>().not.toHaveProperty("getSkill");
  });
});
