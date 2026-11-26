import { eventsOf } from "#harness/publication.js";
import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalStatus } from "#approval/definition.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { callRequested } from "#harness/call-facts.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { estimateTokens } from "#harness/token-estimate.js";

it.each([
  [undefined, "run"],
  [false, "run"],
  [true, "ask"],
  ["not-applicable", "run"],
  ["approved", "run"],
  ["denied", "deny"],
  ["user-approval", "ask"],
  [{ type: "not-applicable" }, "run"],
  [{ type: "approved", reason: "Within the team's policy." }, "run"],
  [{ type: "denied", reason: "Outside the team's policy." }, "deny"],
  [{ type: "user-approval" }, "ask"],
] as const)("preserves policy return %j and records the decision", async (status, outcome) => {
  const execute = vi.fn(() => "saved");
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });
  const events: import("#protocol/session-event.js").SessionEvent[] = [];
  const results = await contextStorage.run(ctx, () =>
    executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "save", type: "tool-call" }],
      tools: new Map([
        [
          "save",
          {
            name: "save",
            description: "Save notes",
            inputSchema: jsonSchema({ type: "object" }),
            execute,
            approval: () => status,
          },
        ],
      ]),
    }),
  );
  expect(execute).toHaveBeenCalledTimes(outcome === "run" ? 1 : 0);
  expect(results.approvals).toHaveLength(outcome === "ask" ? 1 : 0);
  const reason = typeof status === "object" && "reason" in status ? status.reason : undefined;
  if (outcome === "run") {
    const type = typeof status === "object" ? status.type : status;
    expect(events.find((event) => event.type === "call.started")?.data.clearedBy).toEqual(
      type === "approved" ? { policy: "approval" } : undefined,
    );
    expect(results.parts[0]?.output).toEqual({ type: "text", value: "saved" });
  } else if (outcome === "deny") {
    expect(results.parts[0]?.output).toMatchObject({ type: "execution-denied", reason });
    expect(events.map((event) => event.type)).not.toContain("call.started");
    expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
      cause: { policy: "approval" },
      outcome: "rejected",
      output: { code: "TOOL_EXECUTION_DENIED", tool: { result: "not_run" } },
    });
  }
});

it.each([null, "allow", { type: "approved", reason: 123 }])(
  "fails closed for an invalid JavaScript approval return %j",
  async (status) => {
    const execute = vi.fn();
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn_0", sequence: 0 },
    });
    const result = await contextStorage.run(ctx, () =>
      executeInlineCalls({
        abortSignal: undefined,
        approvalMemory: { pending: [], remembered: {} },
        beforeExecute: () => {},
        excludedCallIds: new Set(),
        messages: [],
        publish: async () => {},
        toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "save", type: "tool-call" }],
        tools: new Map([
          [
            "save",
            {
              name: "save",
              description: "Save notes",
              inputSchema: jsonSchema({ type: "object" }),
              execute,
              approval: () => status as ApprovalStatus,
            },
          ],
        ]),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.parts[0]?.output).toMatchObject({ type: "error-text" });
  },
);

it("asks with the prompt a tool's approval writes for the call", async () => {
  const sendPayment: HarnessToolDefinition = {
    approval: {
      prompt: ({ input }) => `Send $${String(input.amount)} to ${String(input.recipient)}?`,
      request: () => "user-approval",
    },
    description: "Send a payment.",
    execute: async () => "sent",
    inputSchema: jsonSchema({ type: "object" }),
    name: "send_payment",
  };
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });

  const results = await contextStorage.run(ctx, () =>
    executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async () => {},
      toolCalls: [
        {
          input: { amount: 125, recipient: "Ada" },
          toolCallId: "call-1",
          toolName: "send_payment",
          type: "tool-call",
        },
      ],
      tools: new Map([["send_payment", sendPayment]]),
    }),
  );

  expect(results.approvals.map((ask) => ask.request.prompt)).toEqual(["Send $125 to Ada?"]);
});

it("keeps a thrown tool error's name in the durable call ending", async () => {
  const events: import("#protocol/session-event.js").SessionEvent[] = [];
  await executeInlineCalls({
    abortSignal: undefined,
    approvalMemory: { pending: [], remembered: {} },
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    publish: async (publication) => {
      events.push(...eventsOf(publication));
    },
    toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "lookup", type: "tool-call" }],
    tools: new Map([
      [
        "lookup",
        {
          name: "lookup",
          description: "Look up a record",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => {
            throw Object.assign(new Error("quota exceeded"), { name: "QuotaError" });
          },
        },
      ],
    ]),
  });
  expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
    error: { name: "QuotaError", message: "quota exceeded" },
    outcome: "failed",
  });
});

it.each(["policy", "prompt"] as const)(
  "settles a broken deferred %s without losing a sibling's result",
  async (failureAt) => {
    const events: import("#protocol/session-event.js").SessionEvent[] = [];
    const deferred: HarnessToolDefinition = {
      name: "schedule",
      description: "Schedule work",
      inputSchema: jsonSchema({ type: "object" }),
      workflowId: "schedule-workflow",
      approval:
        failureAt === "policy"
          ? () => {
              throw new Error("Approval service unavailable");
            }
          : {
              request: () => "user-approval",
              prompt: () => {
                throw new Error("Approval prompt unavailable");
              },
            },
    };
    const result = await executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [
        { input: {}, toolCallId: "broken", toolName: "schedule", type: "tool-call" },
        { input: {}, toolCallId: "saved", toolName: "save", type: "tool-call" },
      ],
      tools: new Map([
        ["schedule", deferred],
        [
          "save",
          {
            name: "save",
            description: "Save notes",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => "saved",
          },
        ],
      ]),
    });
    expect(result.parts).toEqual([
      expect.objectContaining({
        toolCallId: "broken",
        output: expect.objectContaining({ type: "error-text" }),
      }),
      expect.objectContaining({ toolCallId: "saved", output: { type: "text", value: "saved" } }),
    ]);
    expect(
      events
        .filter((event) => event.type === "call.settled")
        .map((event) => [event.data.callId, event.data.outcome])
        .sort(),
    ).toEqual([
      ["broken", "failed"],
      ["saved", "completed"],
    ]);
    expect(result.approvals).toEqual([]);
  },
);

it("closes a streaming tool when progress publication fails", async () => {
  let closed = false;
  const result = await executeInlineCalls({
    abortSignal: undefined,
    approvalMemory: { pending: [], remembered: {} },
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    publish: async (publication) => {
      if (eventsOf(publication).some((event) => event.type === "call.progress"))
        throw new Error("Progress unavailable");
    },
    toolCalls: [{ input: {}, toolCallId: "stream", toolName: "stream", type: "tool-call" }],
    tools: new Map([
      [
        "stream",
        {
          name: "stream",
          description: "Stream work",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async function* () {
            try {
              yield "working";
              yield "done";
            } finally {
              closed = true;
            }
          },
        },
      ],
    ]),
  });
  expect(result.parts[0]?.output).toMatchObject({ type: "error-text" });
  expect(closed).toBe(true);
});

it.each([
  [true, true, "returns"],
  [false, false, "returns"],
  [true, false, "returns"],
  [false, true, "returns"],
  [false, true, "throws"],
] as const)(
  "gives AI SDK integrations tool content per recordInputs %s and recordOutputs %s when the tool %s",
  async (recordInputs, recordOutputs, behavior) => {
    const secret = "alice-invoice-4213";
    const started: Record<string, unknown>[] = [];
    const ended: Record<string, unknown>[] = [];
    await executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [{ role: "user", content: `Find ${secret}` }],
      publish: async () => {},
      telemetry: {
        integrations: [
          {
            onToolExecutionStart: (event) => void started.push(event as never),
            onToolExecutionEnd: (event) => void ended.push(event as never),
          },
        ],
        recordInputs,
        recordOutputs,
      },
      toolCalls: [
        { input: { invoice: secret }, toolCallId: "call-1", toolName: "lookup", type: "tool-call" },
      ],
      tools: new Map([
        [
          "lookup",
          {
            name: "lookup",
            description: "Look up an invoice",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async (args: { invoice: string }) => {
              if (behavior === "throws") throw new Error(`no record for ${args.invoice}`);
              return `found ${args.invoice}`;
            },
          },
        ],
      ]),
    });

    const start = started[0] as { messages: unknown[]; toolCall: { input?: unknown } };
    const output = (ended[0] as { toolOutput: Record<string, unknown> }).toolOutput;
    expect(start.toolCall.input).toEqual(recordInputs ? { invoice: secret } : undefined);
    expect(start.messages).toHaveLength(recordInputs ? 1 : 0);
    expect(output.input).toEqual(recordInputs ? { invoice: secret } : undefined);
    if (behavior === "returns") {
      expect(output.output).toEqual(recordOutputs ? `found ${secret}` : undefined);
    } else {
      expect(String(output.error)).not.toContain(secret);
    }
  },
);

describe("the tokens a call's facts estimate", () => {
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

  async function settledTokens(
    tool: Partial<HarnessToolDefinition>,
    toolInput: Record<string, unknown> = {},
  ): Promise<number | undefined> {
    const events: SessionEvent[] = [];
    await executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [{ input: toolInput, toolCallId: "call-1", toolName: "t", type: "tool-call" }],
      tools: new Map([
        [
          "t",
          { name: "t", description: "T", inputSchema: jsonSchema({ type: "object" }), ...tool },
        ],
      ]),
    });
    const settled = events.find((event) => event.type === "call.settled");
    return settled?.type === "call.settled" ? settled.data.outputTokens : undefined;
  }

  it("counts the text and the JSON the model receives, without the output wrapper", async () => {
    expect(await settledTokens({ execute: () => "x".repeat(400) })).toBe(
      estimateTokens("x".repeat(400)),
    );
    const json = { rows: [1, 2, 3], ok: true };
    expect(await settledTokens({ execute: () => json })).toBe(estimateTokens(json));
  });

  it("counts the preview a tool sends in place of a large output, not the output", async () => {
    const preview = "Saved 1 MB to /tmp/.eve/tool-results/out.json";
    const tokens = await settledTokens({
      execute: () => "y".repeat(1_000_000),
      toModelOutput: () => ({ type: "text", value: preview }),
    });
    expect(tokens).toBe(estimateTokens(preview));
    expect(tokens).toBeLessThan(50);
  });

  it("counts the media in a content output", async () => {
    const withMedia = await settledTokens({
      execute: () => ({}),
      toModelOutput: () => ({
        type: "content",
        value: [
          { type: "text", text: "Screenshot:" },
          { type: "file", data: { type: "data", data: pixel }, mediaType: "image/png" },
        ],
      }),
    });
    const textOnly = await settledTokens({
      execute: () => ({}),
      toModelOutput: () => ({ type: "content", value: [{ type: "text", text: "Screenshot:" }] }),
    });
    expect(withMedia).toBeGreaterThan(textOnly ?? Number.POSITIVE_INFINITY);
  });

  it("counts the error text of a failed call", async () => {
    const tokens = await settledTokens({
      execute: () => {
        throw new Error("quota exceeded for this account");
      },
    });
    expect(tokens).toBe(estimateTokens("Error: quota exceeded for this account"));
  });

  it("counts the message, not the Error object, when output projection throws", async () => {
    const message = "toModelOutput could not render this result for the model";
    const tokens = await settledTokens({
      execute: () => ({}),
      toModelOutput: () => {
        throw new Error(message);
      },
    });
    expect(tokens).toBe(estimateTokens(message));
  });

  it("estimates a call's input and omits it when the input didn't validate", () => {
    const action = {
      callId: "c",
      input: { path: "a.txt" },
      kind: "tool-call",
      toolName: "read",
    } as const;
    expect(callRequested({ action, owner: { runId: "r" } }).data.inputTokens).toBe(
      estimateTokens({ path: "a.txt" }),
    );
    expect(
      callRequested({
        action,
        inputError: { code: "INVALID_INPUT", message: "bad" },
        owner: { runId: "r" },
      }).data,
    ).not.toHaveProperty("inputTokens");
  });
});
