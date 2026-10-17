import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";

import {
  APPROVED_CALL_INTERRUPTED_MESSAGE,
  runApprovedCalls,
} from "#harness/hitl/approved-calls.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { InputRequest } from "#shared/input.js";
import type { HandleEventFn } from "#harness/types.js";

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
    responderOf: () => undefined,
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
    responderOf: () => undefined,
    requests: [approval("call-unstarted", "unstarted")],
    tools: new Map([["unstarted", unstarted]]),
  });

  expect(execute).not.toHaveBeenCalled();
  expect(result.settled).toEqual([]);
});

// https://github.com/vercel/eve/issues/4820
it("keeps the name of the error an approved call threw on its failed result", async () => {
  class QuotaError extends Error {
    override name = "QuotaError";
  }
  const throwing = tool("throwing", async () => {
    throw new QuotaError("quota exceeded");
  });
  const unprojectable = {
    ...tool("unprojectable", async () => "done"),
    toModelOutput: () => {
      throw new QuotaError("projection quota exceeded");
    },
  } as HarnessToolDefinition;
  const published: Parameters<HandleEventFn>[0][] = [];

  const result = await runApprovedCalls({
    abortSignal: new AbortController().signal,
    messages: [],
    position: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    publish: async (event) => {
      published.push(event);
    },
    responderOf: () => undefined,
    requests: [
      approval("call-throwing", "throwing"),
      approval("call-unprojectable", "unprojectable"),
    ],
    tools: new Map([
      ["throwing", throwing],
      ["unprojectable", unprojectable],
    ]),
  });

  expect(result.settled.map(({ part }) => [part.toolCallId, part.output])).toEqual([
    ["call-throwing", { type: "error-text", value: "quota exceeded" }],
    ["call-unprojectable", { type: "error-text", value: "projection quota exceeded" }],
  ]);
  expect(
    published.flatMap((event) =>
      event.type === "action.result" ? [[event.data.result.callId, event.data.error]] : [],
    ),
  ).toEqual([
    [
      "call-throwing",
      { code: "ACTION_RESULT_FAILED", message: "quota exceeded", name: "QuotaError" },
    ],
    [
      "call-unprojectable",
      { code: "ACTION_RESULT_FAILED", message: "projection quota exceeded", name: "QuotaError" },
    ],
  ]);
});
