import { describe, expect, it } from "vitest";

import { strictestApproval, withAgentApproval } from "#approval/agent.js";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalPolicy,
  type ApprovalStatus,
} from "#approval/definition.js";
import { evaluateApproval } from "#approval/evaluation.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SteeredByKey } from "#context/keys.js";
import { always, never, once, steered } from "#tools/approval/policies.js";

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

  it("restricts a custom response policy to the caller when steered() is the agent policy", async () => {
    const alice = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "bob" };
    const allowTeam = () => ({ status: "allowed" as const });
    const approval = withAgentApproval(steered(), {
      request: always(),
      response: allowTeam,
    });
    expect(typeof approval).toBe("object");
    const response = (approval as Exclude<Approval, ApprovalPolicy>).response!;
    const responseCtx = (responder: typeof alice) =>
      ({
        auth: {} as never,
        request: { callId: "call-1", interactionId: "int-1", principal: alice, toolName: "deploy" },
        response: { decision: "approve" as const, principal: responder },
        session: { id: "s1", initiator: alice, turn: { id: "t1", sequence: 0 } },
      }) as never;

    const unsteered = new ContextContainer();
    expect(await contextStorage.run(unsteered, () => response(responseCtx(bob)))).toEqual({
      status: "allowed",
    });

    const steeredCtx = new ContextContainer();
    steeredCtx.set(SteeredByKey, [bob]);
    expect(await contextStorage.run(steeredCtx, () => response(responseCtx(bob)))).toMatchObject({
      status: "rejected",
    });
    expect(await contextStorage.run(steeredCtx, () => response(responseCtx(alice)))).toEqual({
      status: "allowed",
    });

    const toolSteered = withAgentApproval(always(), {
      request: steered(),
      response: allowTeam,
    });
    const toolResponse = (toolSteered as Exclude<Approval, ApprovalPolicy>).response!;
    expect(
      await contextStorage.run(steeredCtx, () => toolResponse(responseCtx(bob))),
    ).toMatchObject({ status: "rejected" });

    const wrappedDecision = await evaluateApproval(
      async (evalCtx) => (await steered()(evalCtx)) ?? "not-applicable",
      {
        abortSignal: new AbortController().signal,
        callId: "call-wrapped",
        session: {
          auth: { current: alice, initiator: alice, steeredBy: [bob] },
          id: "s1",
          turn: { id: "t1", sequence: 0 },
        },
        toolName: "deploy",
      } as never,
    );
    expect(wrappedDecision).toMatchObject({ awaitsPerson: true, callerOnly: true });
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
