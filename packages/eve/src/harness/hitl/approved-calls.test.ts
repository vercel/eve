import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { callSignInsSettled } from "#harness/session-machine/transitions.js";

import {
  APPROVED_CALL_INTERRUPTED_MESSAGE,
  runApprovedCalls,
} from "#harness/hitl/approved-calls.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import { initialSessionProjection } from "#protocol/session-projection.js";

vi.mock("#harness/session-machine/transitions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#harness/session-machine/transitions.js")>()),
  callSignInsSettled: vi.fn(() => []),
}));

const view = () => ({ projection: initialSessionProjection() });

const plainSignIn: AuthorizationChallenge = {
  attemptId: "plain-1",
  challenge: {},
  hookUrl: "https://example.test/plain",
  name: "plain",
};

function approval(callId: string, toolName: string): ApprovalAsk {
  return {
    call: { callId, input: {}, toolName },
    interactionId: `approval-${callId}`,
    request: { kind: "approval", prompt: `Approve tool call: ${toolName}` },
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
    publish: async () => {},
    view,
    approvals: [approval("call-finished", "finished"), approval("call-cut", "cut")],
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
    publish: async () => {},
    view,
    approvals: [approval("call-unstarted", "unstarted")],
    tools: new Map([["unstarted", unstarted]]),
  });

  expect(execute).not.toHaveBeenCalled();
  expect(result.settled).toEqual([]);
});

it("accepts a sign-in whose call fails before its tool runs, not as a failed authorization", async () => {
  vi.mocked(callSignInsSettled).mockClear();
  // The tool's schema changed while the call waited on the sign-in: its stored input no longer
  // validates, so the call fails before `completeAuthorization` runs in it.
  const lookup = {
    ...tool("plain__getPlainWorkspaceAndUser", async () => "never"),
    inputSchema: jsonSchema(
      {
        type: "object",
        properties: { workspaceId: { type: "string" } },
        required: ["workspaceId"],
      },
      {
        validate: (value) => ({
          success: false,
          error: new Error(`rejected ${JSON.stringify(value)}`),
        }),
      },
    ),
  } as HarnessToolDefinition;
  const execute = vi.spyOn(lookup, "execute");
  const approved = { ...approval("call-lookup", lookup.name), signIns: [plainSignIn] };

  const result = await runApprovedCalls({
    abortSignal: undefined,
    messages: [],
    publish: async () => {},
    view,
    approvals: [approved],
    tools: new Map([[lookup.name, lookup]]),
  });

  expect(execute).not.toHaveBeenCalled();
  // The call's own result still tells the model why it didn't run.
  expect(result.settled[0]?.part.output).toEqual({
    type: "error-text",
    value: `The approved input is no longer valid for tool "${lookup.name}". Request a new tool call and approval.`,
  });
  expect(callSignInsSettled).toHaveBeenCalledOnce();
  expect(vi.mocked(callSignInsSettled).mock.calls[0]?.[2]).toBeUndefined();
});

it("still fails a sign-in whose call throws once its tool runs", async () => {
  vi.mocked(callSignInsSettled).mockClear();
  const lookup = tool("lookup", async () => {
    throw new Error("token exchange failed");
  });
  const approved = { ...approval("call-lookup", "lookup"), signIns: [plainSignIn] };

  await runApprovedCalls({
    abortSignal: undefined,
    messages: [],
    publish: async () => {},
    view,
    approvals: [approved],
    tools: new Map([["lookup", lookup]]),
  });

  expect(callSignInsSettled).toHaveBeenCalledOnce();
  expect(vi.mocked(callSignInsSettled).mock.calls[0]?.[2]).toEqual({
    reason: "token exchange failed",
  });
});
