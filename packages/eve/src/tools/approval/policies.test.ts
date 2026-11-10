import { beforeEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
vi.mock("#ai/decide.js", () => ({ decide }));

import type { ApprovalContext } from "#approval/definition.js";
import { strictestApproval } from "#approval/agent.js";
import { evaluateApproval, rememberDecision } from "#approval/evaluation.js";
import type { SessionAuthContext } from "#channel/types.js";
import { always, auto, never, once } from "#tools/approval/policies.js";

function approvalContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: vi.fn(),
    session: {
      auth: { current: null, initiator: null, sender: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolInput: { environment: "production" },
    toolName: "deploy",
    ...overrides,
  };
}

describe("dynamic tool approval helpers", () => {
  beforeEach(() => decide.mockReset());

  it.each([
    ["always", always(), "user-approval"],
    ["never", never(), "not-applicable"],
    ["once", once(), "user-approval"],
  ] as const)("%s returns its fixed decision", async (_name, policy, expected) => {
    expect(await policy(approvalContext())).toEqual(expected);
  });

  it.each([
    ["clear", "approved"],
    ["caution", "user-approval"],
  ] as const)("maps the automatic review's %s decision to %s", async (choice, expected) => {
    decide.mockResolvedValueOnce({ answers: { permission: { choice } } });
    const context = approvalContext();

    await expect(auto()(context)).resolves.toBe(expected);
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        maxRetries: 0,
        model: "typesafe-ai/jev",
        state: { action: { input: context.toolInput, tool: "deploy" } },
      }),
    );
  });

  it("forwards provider options to the decision model", async () => {
    decide.mockResolvedValueOnce({ answers: { permission: { choice: "clear" } } });

    await auto({
      modelOptions: { providerOptions: { gateway: { zeroDataRetention: true } } },
    })(approvalContext());

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { gateway: { zeroDataRetention: true } },
      }),
    );
  });

  it("allows classifier instructions and outcome descriptions to be overridden", async () => {
    decide.mockResolvedValueOnce({ answers: { permission: { choice: "clear" } } });
    const context = approvalContext();

    await auto({
      model: "custom-decider",
      instructions: "Classify this action for my application.",
      criteria: {
        clear: "The action is within policy.",
        caution: "The action needs review.",
      },
    })(context);

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "custom-decider",
        questions: {
          permission: {
            type: "choice",
            instructions: "Classify this action for my application.",
            criteria: {
              clear: "The action is within policy.",
              caution: "The action needs review.",
            },
          },
        },
      }),
    );
  });

  it("accepts another decision model", async () => {
    decide.mockResolvedValueOnce({ answers: { permission: { choice: "clear" } } });
    const model = { modelId: "custom", provider: "test", specificationVersion: "v4" } as never;
    const context = approvalContext();

    const policy = auto({ model });
    await expect(policy(context)).resolves.toBe("approved");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it.each([new Date(), new Map([["kind", "delete"]]), new Set(["delete"]), Number.NaN])(
    "requires approval without deciding lossy input %#",
    async (toolInput) => {
      await expect(auto()(approvalContext({ toolInput: { value: toolInput } }))).resolves.toBe(
        "user-approval",
      );
      expect(decide).not.toHaveBeenCalled();
    },
  );

  it("requires approval without deciding oversized input", async () => {
    const context = approvalContext({ toolInput: { value: "x".repeat(64 * 1024) } });

    await expect(auto()(context)).resolves.toBe("user-approval");
    expect(decide).not.toHaveBeenCalled();
  });

  it("fails closed when the automatic review is unavailable", async () => {
    decide.mockRejectedValueOnce(new Error("unavailable"));
    await expect(auto()(approvalContext())).resolves.toBe("user-approval");
  });

  it("propagates cancellation instead of requesting approval", async () => {
    const reason = new Error("cancelled");
    decide.mockRejectedValueOnce(reason);
    const context = approvalContext({ abortSignal: AbortSignal.abort(reason) });

    await expect(auto()(context)).rejects.toBe(reason);
  });

  it("rejects removed scoped options instead of broadening approval", () => {
    expect(() => {
      // @ts-expect-error once() remembers the tool, not a selected input scope.
      once({ key: (input: { environment: string }) => input.environment });
    }).toThrow('once() accepts only { when: "principal-mismatch" }');
  });
});

describe('approval helpers with { when: "principal-mismatch" }', () => {
  const user = (principalId: string): SessionAuthContext => ({
    attributes: {},
    authenticator: "slack",
    principalId,
    principalType: "user",
  });
  const [alice, bob, carol] = [user("alice"), user("bob"), user("carol")];
  const when = "principal-mismatch" as const;
  const turn = (
    current: SessionAuthContext,
    sender: SessionAuthContext,
    initiator: SessionAuthContext,
  ) =>
    approvalContext({
      session: { ...approvalContext().session, auth: { current, initiator, sender } },
    });

  it.each([
    ["always", always({ when })],
    ["once", once({ when })],
  ] as const)(
    "%s doesn't ask while caller, sender, and initiator are one person",
    async (_, policy) => {
      expect(await evaluateApproval(policy, turn(alice, alice, alice))).toEqual({ denied: false });
    },
  );

  it("always asks after someone else speaks, and only the caller can approve", async () => {
    expect(await evaluateApproval(always({ when }), turn(alice, bob, alice))).toEqual({
      awaitsPerson: true,
      callerApproves: true,
      denied: false,
    });
  });

  it("keeps the request caller-only when a tool's own policy also asks", async () => {
    const agentWide = always({ when });
    const toolOwn = always();
    expect(
      await evaluateApproval(strictestApproval([agentWide, toolOwn]), turn(alice, bob, alice)),
    ).toEqual({ awaitsPerson: true, callerApproves: true, denied: false });
  });

  it("once remembers the caller's approval for its combination and the one approving leads to", async () => {
    const policy = once({ when });
    // Carol started the session, Bob is the caller, and Alice spoke last.
    const asked = await evaluateApproval(policy, turn(bob, alice, carol));
    expect(asked).toMatchObject({ awaitsPerson: true, callerApproves: true });
    const memory = {
      pending: [],
      remembered: rememberDecision(
        {},
        { interactionId: "approval-1", remember: asked.remember },
        "accepted",
      ),
    };

    // Alice steering Bob again, and Bob's next call once he is the sender, run on his approval
    // and get his token.
    for (const context of [turn(bob, alice, carol), turn(bob, bob, carol)]) {
      expect(await evaluateApproval(policy, context, { memory })).toEqual({
        callerConfirmed: true,
        clearedBy: { policy: "approval" },
        denied: false,
      });
    }
    // Dave speaking is a new combination, so Bob is asked again.
    expect(
      await evaluateApproval(policy, turn(bob, user("dave"), carol), { memory }),
    ).toMatchObject({ awaitsPerson: true });
  });
});
