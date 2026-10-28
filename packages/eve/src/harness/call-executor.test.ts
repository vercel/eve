import { eventsOf } from "#harness/publication.js";
import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";
import type { ApprovalStatus } from "#approval/definition.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

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
    // A refusal is told apart from a body that ran and failed: it rejects, and never starts.
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
