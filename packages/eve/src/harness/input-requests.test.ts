import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { once } from "#public/tools/approval/approval-helpers.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  consumeDeferredStepInput,
  createRuntimeToolCallActionFromToolCall,
  getApprovedTools,
  hasDeferredStepInput,
  hasStepInput,
  resolvePendingInput,
  setPendingInputBatch,
} from "#harness/input-requests.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

type NeedsApprovalFn = (input: unknown, context: unknown) => Promise<boolean> | boolean;

function createHarnessSession(): HarnessSession {
  return {
    agent: {
      modelReference: { modelId: "test", provider: "test" } as never,
      system: "",
      tools: [],
    },
    compaction: {
      recentWindowSize: 10,
      threshold: 0.8,
    },
    continuationToken: "test",
    history: [{ content: "previous", role: "user" }],
    sessionId: "sess-test",
  };
}

describe("hasStepInput", () => {
  it("returns false when input is undefined", () => {
    expect(hasStepInput(undefined)).toBe(false);
  });

  it("returns false when input has no message", () => {
    expect(hasStepInput({})).toBe(false);
  });

  it("returns true when input has a message", () => {
    expect(hasStepInput({ message: "hello" })).toBe(true);
  });
});

describe("createRuntimeToolCallActionFromToolCall", () => {
  it("creates a tool-call action from a typed tool call", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-123",
        toolName: "bash",
        input: { command: "ls -la" },
        type: "tool-call",
      } as never,
    });

    expect(result).toEqual({
      callId: "call-123",
      input: { command: "ls -la" },
      kind: "tool-call",
      toolName: "bash",
    });
  });

  it("defaults to empty object when input is undefined", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-456",
        toolName: "read_file",
        input: undefined,
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({});
  });

  it("omits undefined properties from tool call input objects", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-789",
        toolName: "read_file",
        input: {
          path: "/workspace/foo.txt",
          startLine: undefined,
        },
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({
      path: "/workspace/foo.txt",
    });
  });
});

describe("resolvePendingInput", () => {
  it("resolves pending question input with responses", () => {
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "question-call",
            input: { prompt: "Pick one." },
            kind: "tool-call",
            toolName: "ask_question",
          },
          display: "select",
          prompt: "Pick one.",
          requestId: "question-call",
        },
        {
          action: {
            callId: "approval-call",
            input: { command: "rm -rf /tmp/demo" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [
        {
          content: [
            { text: "Need input.", type: "text" },
            {
              input: { prompt: "Pick one." },
              toolCallId: "question-call",
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [
          {
            requestId: "question-call",
            optionId: "yes",
          },
        ],
      },
      session,
    });

    const pendingResponseMessage = (
      session.state?.["eve.runtime.pendingInputBatch"] as
        | { responseMessages?: readonly ModelMessage[] }
        | undefined
    )?.responseMessages?.[0];

    expect(result.outcome).toBe("resolved");
    expect(result.messages).toEqual([
      { content: "previous", role: "user" },
      pendingResponseMessage,
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                optionId: "yes",
                status: "answered",
              },
            },
            toolCallId: "question-call",
            toolName: "ask_question",
            type: "tool-result",
          },
          {
            approvalId: "approval-1",
            approved: false,
            reason: "Ignored because the user continued without responding.",
            type: "tool-approval-response",
          },
          {
            output: {
              type: "execution-denied",
              reason: "Ignored because the user continued without responding.",
            },
            toolCallId: "approval-call",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  it("synthesizes ignored responses before a follow-up message", () => {
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "question-call",
            input: { prompt: "Pick one." },
            kind: "tool-call",
            toolName: "ask_question",
          },
          display: "text",
          prompt: "Pick one.",
          requestId: "question-call",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            { text: "Need input.", type: "text" },
            {
              input: { prompt: "Pick one." },
              toolCallId: "question-call",
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    // A message-only delivery with no inputResponses — the pending batch
    // is auto-ignored so the model can continue.
    const result = resolvePendingInput({
      stepInput: {
        message: "Ignore that and continue.",
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.messages.at(-1)).toEqual({
      content: [
        {
          output: {
            type: "json",
            value: {
              status: "ignored",
            },
          },
          toolCallId: "question-call",
          toolName: "ask_question",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("defers a follow-up message until after tool approvals are resolved", () => {
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "rm -rf /tmp/demo" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "rm -rf /tmp/demo" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "approval-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    // Deliver an approval response AND a message simultaneously.
    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
        message: "Ignore that and say hi instead.",
      },
      session,
    });

    // The approval should be resolved immediately.
    expect(result.outcome).toBe("resolved");

    // The follow-up message should be deferred.
    expect(result.deferredMessage).toBe(true);
    expect(hasDeferredStepInput(result.session)).toBe(true);

    const deferred = consumeDeferredStepInput({
      session: result.session,
    });

    expect(deferred.input).toEqual({
      message: "Ignore that and say hi instead.",
    });
    expect(hasDeferredStepInput(deferred.session)).toBe(false);
  });

  it("records compound approval key when resolveApprovalKey is provided", () => {
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { teamId: "team_abc", limit: 10 },
            kind: "tool-call",
            toolName: "vercel__list_projects",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: vercel__list_projects",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { teamId: "team_abc", limit: 10 },
              toolCallId: "approval-call",
              toolName: "vercel__list_projects",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "approval-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      resolveApprovalKey: (request) => {
        const team = request.action.input?.teamId;
        return typeof team === "string" ? `${request.action.toolName}:${team}` : undefined;
      },
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    const approved = getApprovedTools(result.session);
    expect(approved.has("vercel__list_projects:team_abc")).toBe(true);
    expect(approved.has("vercel__list_projects")).toBe(false);
  });

  it("emits a matching execution-denied tool-result when the user explicitly denies an approval", () => {
    /*
     * AI SDK's `streamText` synthesizes an `execution-denied`
     * tool-result for the current turn only — on subsequent turns the
     * persisted `tool-approval-response` gets stripped during provider
     * prompt conversion, leaving the prior `tool_use` block
     * unmatched. The harness must emit the matching tool-result
     * itself so persisted history is replay-safe.
     */
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "pwd" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "approval-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.messages.at(-1)).toEqual({
      content: [
        {
          approvalId: "approval-1",
          approved: false,
          reason: undefined,
          type: "tool-approval-response",
        },
        {
          output: { type: "execution-denied", reason: undefined },
          toolCallId: "approval-call",
          toolName: "bash",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("returns a rejected action for an explicitly denied approval", () => {
    const session = setPendingInputBatch({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toEqual({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      results: [
        {
          callId: "approval-call",
          isError: true,
          kind: "tool-result",
          output: {
            code: "TOOL_EXECUTION_DENIED",
            message: "Tool execution was denied.",
          },
          toolName: "bash",
        },
      ],
    });
  });

  it("does not return a rejected action when an approval is granted", () => {
    const session = setPendingInputBatch({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toBeUndefined();
  });

  it("returns a rejected action when a pending approval is auto-denied by a follow-up message", () => {
    const session = setPendingInputBatch({
      event: { sequence: 7, stepIndex: 2, turnId: "turn_1" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: { message: "Never mind, do something else." },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions?.event).toEqual({ sequence: 7, stepIndex: 2, turnId: "turn_1" });
    expect(result.rejectedActions?.results).toEqual([
      {
        callId: "approval-call",
        isError: true,
        kind: "tool-result",
        output: {
          code: "TOOL_EXECUTION_DENIED",
          message: "Ignored because the user continued without responding.",
        },
        toolName: "bash",
      },
    ]);
  });

  it("falls back to tool name when no approvalKey is provided", () => {
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "rm -rf /tmp" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "rm -rf /tmp" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "approval-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    const approved = getApprovedTools(result.session);
    expect(approved.has("bash")).toBe(true);
  });

  it("approval survives the authorization park so an auth+approval tool is not approved twice", () => {
    // A tool requiring both approval and auth is approved first, then its
    // execute parks for sign-in. On resume the step re-runs and the toolset
    // is rebuilt from the persisted approvedTools. The recorded approval must
    // survive on session.state across the park, so needsApproval returns
    // false and the user is never asked to approve a second time.
    // See research/per-tool-auth-known-issues.md, issue 3.
    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: {},
            kind: "tool-call",
            toolName: "linear_whoami",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: linear_whoami",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: {},
              toolCallId: "approval-call",
              toolName: "linear_whoami",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "approval-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");

    // The resume-after-sign-in step rebuilds the toolset from the persisted
    // approvals. once() must not re-request approval for the now-approved tool.
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "linear_whoami",
        {
          description: "Resolve the caller's Linear identity.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "linear_whoami",
          needsApproval: once(),
        },
      ],
    ]);

    const rebuilt = buildToolSet({
      approvedTools: getApprovedTools(result.session),
      tools,
    });
    const needsApproval = (rebuilt.linear_whoami as { needsApproval?: NeedsApprovalFn })
      .needsApproval;

    return expect(needsApproval?.({}, {})).resolves.toBe(false);
  });
});
