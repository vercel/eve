import { jsonSchema, type ToolSet, type TypedToolCall } from "ai";
import { expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

it("tells the model a failed call's error as the AI SDK did, name included", async () => {
  const lookup: HarnessToolDefinition = {
    description: "Look up a record.",
    execute: async () => {
      throw Object.assign(new Error("Record service timed out"), { name: "TimeoutError" });
    },
    inputSchema: jsonSchema({ type: "object" }),
    name: "lookup_record",
  };
  const call: TypedToolCall<ToolSet> = {
    input: {},
    toolCallId: "call-1",
    toolName: "lookup_record",
    type: "tool-call",
  };
  const published: UnstampedMessageStreamEvent[] = [];

  const results = await executeInlineCalls({
    abortSignal: undefined,
    approvedTools: new Set(),
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    position: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    publish: async (event) => {
      published.push(event);
    },
    toolCalls: [call],
    tools: new Map([["lookup_record", lookup]]),
  });

  expect(results.parts.map((part) => part.output)).toEqual([
    { type: "error-text", value: "TimeoutError: Record service timed out" },
  ]);
  // The stream reports the message alone, as it did when the AI SDK ran the call.
  const result = published.find((event) => event.type === "action.result");
  expect(result?.type === "action.result" && result.data.result.output).toBe(
    "Record service timed out",
  );
});

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
      approvedTools: new Set(),
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      position: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
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

  expect(results.approvals.map((request) => request.prompt)).toEqual(["Send $125 to Ada?"]);
});
