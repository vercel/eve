import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("#ai/evaluate.js", () => ({ evaluate }));

import type { ApprovalContext } from "#approval/definition.js";
import { always, auto, isNeverApprovalPolicy, never, once } from "#tools/approval/policies.js";
import { readDurableDynamicCallback } from "#tools/durable-callbacks.js";

function approvalContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    abortSignal: new AbortController().signal,
    approvedTools: new Set(),
    callId: "call-1",
    getSandbox: vi.fn(),
    getSkill: vi.fn(),
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolInput: { environment: "production" },
    toolName: "deploy",
    ...overrides,
  };
}

describe("dynamic tool approval helpers", () => {
  beforeEach(() => evaluate.mockReset());

  it.each([
    ["always", always(), "user-approval"],
    ["never", never(), "not-applicable"],
  ] as const)("gives %s a stable replay descriptor", async (_name, policy, expected) => {
    const reference = readDurableDynamicCallback(policy);
    expect(reference?.callback).toBeTypeOf("function");
    expect(reference?.closure).toEqual({});

    expect(await reference!.callback(reference!.closure, {} as never)).toBe(expected);
  });

  it("recognizes only the built-in never policy without executing approval callbacks", () => {
    const policy = never();
    const custom = vi.fn(() => "not-applicable" as const);

    expect(isNeverApprovalPolicy(policy)).toBe(true);
    expect(isNeverApprovalPolicy({ request: policy })).toBe(true);
    expect(isNeverApprovalPolicy(always())).toBe(false);
    expect(isNeverApprovalPolicy(once())).toBe(false);
    expect(isNeverApprovalPolicy(auto())).toBe(false);
    expect(isNeverApprovalPolicy(custom)).toBe(false);
    expect(custom).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(policy, Symbol.for("eve:never-approval-policy")),
    ).toMatchObject({ enumerable: false, value: true });
  });

  it.each([
    ["clear", "approved"],
    ["caution", "user-approval"],
  ] as const)("maps the automatic review's %s decision to %s", async (choice, expected) => {
    evaluate.mockResolvedValueOnce({ answers: { permission: { choice } } });
    const context = approvalContext();

    await expect(auto()(context)).resolves.toBe(expected);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        maxRetries: 0,
        model: "typesafe-ai/jev",
        state: { action: { input: context.toolInput, tool: "deploy" } },
      }),
    );
  });

  it("allows classifier instructions and outcome descriptions to be overridden", async () => {
    evaluate.mockResolvedValueOnce({ answers: { permission: { choice: "clear" } } });
    const context = approvalContext();

    await auto({
      model: "custom-evaluator",
      instructions: "Classify this action for my application.",
      criteria: {
        clear: "The action is within policy.",
        caution: "The action needs review.",
      },
    })(context);

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "custom-evaluator",
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

  it("accepts another evaluation model", async () => {
    evaluate.mockResolvedValueOnce({ answers: { permission: { choice: "clear" } } });
    const model = { modelId: "custom", provider: "test", specificationVersion: "v4" } as never;
    const context = approvalContext();

    await expect(auto({ model })(context)).resolves.toBe("approved");
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it.each([new Date(), new Map([["kind", "delete"]]), new Set(["delete"]), Number.NaN])(
    "requires approval without evaluating lossy input %#",
    async (toolInput) => {
      await expect(auto()(approvalContext({ toolInput: { value: toolInput } }))).resolves.toBe(
        "user-approval",
      );
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it("requires approval without evaluating oversized input", async () => {
    const context = approvalContext({ toolInput: { value: "x".repeat(64 * 1024) } });

    await expect(auto()(context)).resolves.toBe("user-approval");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when the automatic review is unavailable", async () => {
    evaluate.mockRejectedValueOnce(new Error("unavailable"));
    await expect(auto()(approvalContext())).resolves.toBe("user-approval");
  });

  it("propagates cancellation instead of requesting approval", async () => {
    const reason = new Error("cancelled");
    evaluate.mockRejectedValueOnce(reason);
    const context = approvalContext({ abortSignal: AbortSignal.abort(reason) });

    await expect(auto()(context)).rejects.toBe(reason);
  });

  it("replays once against the current approval context", async () => {
    const reference = readDurableDynamicCallback(once())!;

    expect(
      await reference.callback(reference.closure, {
        approvedTools: new Set(),
        toolName: "guarded",
      } as never),
    ).toBe("user-approval");
    expect(
      await reference.callback(reference.closure, {
        approvedTools: new Set(["guarded"]),
        toolName: "guarded",
      } as never),
    ).toBe("not-applicable");
  });
});
