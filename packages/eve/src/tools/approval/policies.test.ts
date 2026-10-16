import { beforeEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
vi.mock("#ai/decide.js", () => ({ decide }));

import { resolveApprovalPolicy, type ApprovalContext } from "#approval/definition.js";
import { defineTool } from "#tools/definition.js";
import { z } from "zod";
import { withApprovalGrants } from "#harness/approval-recheck.js";
import { always, auto, never, once } from "#tools/approval/policies.js";
import { readDurableDynamicCallback } from "#tools/durable-callbacks.js";

function approvalContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: vi.fn(),
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
  beforeEach(() => decide.mockReset());

  it.each([
    ["always", always(), "user-approval"],
    ["never", never(), "not-applicable"],
  ] as const)("gives %s a stable replay descriptor", async (_name, policy, expected) => {
    const reference = readDurableDynamicCallback(policy);
    expect(reference?.callback).toBeTypeOf("function");
    expect(reference?.closure).toEqual({});

    expect(await reference!.callback(reference!.closure, {} as never)).toBe(expected);
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
        abortSignal: expect.any(AbortSignal),
        maxRetries: 0,
        model: "typesafe-ai/jev",
        state: { action: { input: context.toolInput, tool: "deploy" } },
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

    await expect(auto({ model })(context)).resolves.toBe("approved");
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

  it("replays a keyed once policy against the current approval context", async () => {
    const reference = readDurableDynamicCallback(
      once<Record<string, unknown>>({
        key: (input) => String(input.environment),
      }),
    )!;
    const input = { environment: "production" };
    const context = approvalContext({ toolName: "guarded", toolInput: input });
    expect(await reference.callback(reference.closure, context as never)).toBe("user-approval");
    withApprovalGrants(context, [
      { toolName: "guarded", key: "production", interactionId: "approval-1" },
    ]);
    expect(await reference.callback(reference.closure, context as never)).toBe("not-applicable");
    input.environment = "development";
    expect(await reference.callback(reference.closure, context as never)).toBe("user-approval");
  });

  it("does not use an unkeyed grant when a keyed policy has no input", async () => {
    const key = vi.fn((input: Record<string, unknown>) => String(input.environment));
    const context = withApprovalGrants(approvalContext({ toolInput: undefined }), [
      { toolName: "deploy", interactionId: "unkeyed-approval" },
    ]);
    expect(await once({ key })(context)).toBe("user-approval");
    expect(key).not.toHaveBeenCalled();
  });

  it("fails closed when a JavaScript key callback does not return a string", async () => {
    const policy = once({ key: (() => undefined) as never });
    expect(() => policy(approvalContext())).toThrow("must return a string key");
  });

  it("infers keyed input from defineTool's schema in shorthand and configuration forms", async () => {
    const inputSchema = z.object({ environment: z.enum(["dev", "prod"]), sha: z.string() });
    const direct = defineTool({
      description: "Deploy a release",
      inputSchema,
      approval: once({
        key: (input) => {
          // @ts-expect-error Key callbacks must use fields from inputSchema.
          void input.missing;
          return input.environment;
        },
      }),
      execute: () => "deployed",
    });
    const configured = defineTool({
      description: "Deploy a release",
      inputSchema,
      approval: {
        request: once({
          key: (input) => {
            // @ts-expect-error Key callbacks must use fields from inputSchema.
            void input.missing;
            return input.environment;
          },
        }),
        prompt: ({ input }) => `Deploy ${input.environment}?`,
      },
      execute: () => "deployed",
    });
    const context: ApprovalContext<z.infer<typeof inputSchema>> = withApprovalGrants(
      {
        ...approvalContext(),
        toolInput: { environment: "prod", sha: "abc" },
      },
      [{ toolName: "deploy", key: "prod", interactionId: "approval-1" }],
    );
    expect(await resolveApprovalPolicy(direct.approval!)(context)).toBe("not-applicable");
    expect(await resolveApprovalPolicy(configured.approval!)(context)).toBe("not-applicable");
  });
});
