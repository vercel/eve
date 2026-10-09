import { jsonSchema, type ToolSet, type TypedToolCall } from "ai";
import { expect, it } from "vitest";

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
