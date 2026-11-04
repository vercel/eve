import { describe, expect, it } from "vitest";

import { strictestApproval, withAgentApproval } from "#approval/agent.js";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalPolicy,
  type ApprovalStatus,
} from "#approval/definition.js";
import { evaluateApproval } from "#approval/evaluation.js";
import { always, never, once } from "#tools/approval/policies.js";

const ctx = (toolName: string, toolInput?: Record<string, unknown>) =>
  ({ abortSignal: new AbortController().signal, callId: "call-1", toolInput, toolName }) as never;

const decide = (approval: Approval | undefined, toolName = "bash") =>
  resolveApprovalPolicy(approval!)(ctx(toolName));

describe("withAgentApproval", () => {
  it("keeps the entry's own approval object when the agent authors none", () => {
    const own: Approval = () => "user-approval";
    expect(withAgentApproval(undefined, own)).toBe(own);
    expect(withAgentApproval(undefined, undefined)).toBeUndefined();
  });

  it("applies the agent's policy alone to an entry without one", async () => {
    expect(await decide(withAgentApproval(always(), undefined))).toBe("user-approval");
  });

  it("returns the stricter status, so the agent can add a gate but never remove one", async () => {
    const cases: [ApprovalStatus, ApprovalStatus, ApprovalStatus][] = [
      ["user-approval", "not-applicable", "user-approval"],
      ["not-applicable", "user-approval", "user-approval"],
      ["approved", "user-approval", "user-approval"],
      [undefined, "approved", "approved"],
      ["user-approval", { type: "denied", reason: "no" }, { type: "denied", reason: "no" }],
    ];
    for (const [agent, own, expected] of cases) {
      expect(
        await decide(
          withAgentApproval(
            () => agent,
            () => own,
          ),
        ),
      ).toEqual(expected);
    }
  });

  it("stops at the agent's denial without running the entry's policy", async () => {
    let ownRan = false;
    const agent: ApprovalPolicy = ({ toolInput }) =>
      String(toolInput?.command).includes("rm -rf")
        ? { type: "denied", reason: "blocked" }
        : undefined;
    const approval = withAgentApproval(agent, () => {
      ownRan = true;
      return "approved";
    });
    expect(await resolveApprovalPolicy(approval!)(ctx("bash", { command: "rm -rf /" }))).toEqual({
      type: "denied",
      reason: "blocked",
    });
    expect(ownRan).toBe(false);
  });

  it("keeps the entry's once() memory when both ask", async () => {
    const approval = withAgentApproval(always(), once());
    const decision = await evaluateApproval(resolveApprovalPolicy(approval!), ctx("deploy"));
    expect(decision.awaitsPerson).toBe(true);
    expect(decision.remember).toBeDefined();
  });

  it("keeps the agent's reason for asking, and the entry's once() memory, when both ask", async () => {
    const agent: ApprovalPolicy = () => ({
      reason: "Alice's notes are in context.",
      type: "user-approval",
    });
    const decision = await evaluateApproval(
      resolveApprovalPolicy(withAgentApproval(agent, once())!),
      ctx("deploy"),
    );
    expect(decision).toMatchObject({ awaitsPerson: true, reason: "Alice's notes are in context." });
    expect(decision.remember).toBeDefined();
  });

  describe("after a person approved the tool's once()", () => {
    const approvedOnce = {
      memory: {
        pending: [],
        remembered: {
          [JSON.stringify(["deploy", "once"])]: {
            interactionId: "i-1",
            outcome: "accepted" as const,
          },
        },
      },
    };

    it("still asks on every call when the agent's policy asks like always()", async () => {
      const approval = withAgentApproval(always(), once());
      const decision = await evaluateApproval(
        resolveApprovalPolicy(approval!),
        ctx("deploy"),
        approvedOnce,
      );
      expect(decision.awaitsPerson).toBe(true);
    });

    it("runs when the agent's policy asks with once(), which shares the tool's memory", async () => {
      const approval = withAgentApproval(once(), once());
      const decision = await evaluateApproval(
        resolveApprovalPolicy(approval!),
        ctx("deploy"),
        approvedOnce,
      );
      expect(decision).toEqual({ clearedBy: { policy: "approval" }, denied: false });
    });
  });

  it("keeps the entry's prompt and response policy", () => {
    const prompt = () => "Refund?";
    const response = () => ({ status: "allowed" as const });
    const approval = withAgentApproval(never(), { prompt, request: always(), response });
    expect(approval).toMatchObject({ prompt, response });
  });
});

describe("strictestApproval", () => {
  it("leaves the decision to the others when a policy returns undefined", async () => {
    expect(await strictestApproval([() => undefined, () => "approved"])(ctx("bash"))).toBe(
      "approved",
    );
    expect(await strictestApproval([() => undefined])(ctx("bash"))).toBeUndefined();
  });
});
