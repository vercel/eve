import { eventsOf } from "#harness/publication.js";
import { jsonSchema } from "ai";
import { expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

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
      position: { turnId: "turn_0" },
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
    approvedTools: new Set(),
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    position: { turnId: "turn_0" },
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
