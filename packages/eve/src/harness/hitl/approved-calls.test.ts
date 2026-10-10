import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";

import {
  APPROVED_CALL_INTERRUPTED_MESSAGE,
  runApprovedCalls,
} from "#harness/hitl/approved-calls.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { InputRequest } from "#shared/input.js";

function approval(callId: string, toolName: string): InputRequest {
  return {
    action: { callId, input: {}, kind: "tool-call", toolName },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Yes" },
      { id: "cancel", label: "No" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId: `approval-${callId}`,
  };
}

function tool(name: string, execute: () => Promise<unknown>): HarnessToolDefinition {
  return {
    description: name,
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  } as HarnessToolDefinition;
}

it("settles calls a cancellation cut short, and keeps their siblings' results", async () => {
  const controller = new AbortController();
  const finished = tool("finished", async () => "done");
  const cut = tool("cut", async () => {
    // The sibling has its result before the turn is cancelled.
    await Promise.resolve();
    controller.abort(new TurnCancelledError());
    throw controller.signal.reason;
  });
  const execute = { cut: vi.spyOn(cut, "execute"), finished: vi.spyOn(finished, "execute") };

  const result = await runApprovedCalls({
    abortSignal: controller.signal,
    messages: [],
    position: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    publish: async () => {},
    requests: [approval("call-finished", "finished"), approval("call-cut", "cut")],
    tools: new Map([
      ["finished", finished],
      ["cut", cut],
    ]),
  });

  expect(execute.finished).toHaveBeenCalledOnce();
  expect(execute.cut).toHaveBeenCalledOnce();
  expect(result.settled.map(({ part }) => [part.toolCallId, part.output])).toEqual([
    ["call-finished", { type: "text", value: "done" }],
    ["call-cut", { type: "error-text", value: APPROVED_CALL_INTERRUPTED_MESSAGE }],
  ]);
});

it("leaves a call the cancellation stopped before it started without a result", async () => {
  const controller = new AbortController();
  controller.abort(new TurnCancelledError());
  const unstarted = tool("unstarted", async () => "never");
  const execute = vi.spyOn(unstarted, "execute");

  const result = await runApprovedCalls({
    abortSignal: controller.signal,
    messages: [],
    position: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    publish: async () => {},
    requests: [approval("call-unstarted", "unstarted")],
    tools: new Map([["unstarted", unstarted]]),
  });

  expect(execute).not.toHaveBeenCalled();
  expect(result.settled).toEqual([]);
});
