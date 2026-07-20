import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
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
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { buildToolApproval, buildToolSet } from "#harness/tools.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

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

  it("includes the tool name when tool call input is not a JSON object", () => {
    expect(() =>
      createRuntimeToolCallActionFromToolCall({
        toolCall: {
          toolCallId: "call-123",
          toolName: "bash",
          input: [],
          type: "tool-call",
        } as never,
      }),
    ).toThrow(
      'Failed to parse tool-call arguments for "bash" (call-123): Expected a JSON-serializable object.',
    );
  });
});

describe("resolvePendingInput", () => {
  it("keeps approvals pending when another request is answered first", () => {
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

    expect(result.outcome).toBe("unresolved");
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
    expect(hasDeferredStepInput(result.session)).toBe(true);

    const deferred = consumeDeferredStepInput({ session: result.session });
    expect(deferred.input).toEqual({
      inputResponses: [
        {
          requestId: "question-call",
          optionId: "yes",
        },
      ],
    });
  });

  it("resolves freeform question input from a follow-up message", () => {
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
              optionId: undefined,
              text: "Ignore that and continue.",
              status: "answered",
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

  it("defers channel context until after tool approvals are resolved", () => {
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

    const context = "<linear_context>issue metadata</linear_context>";
    const result = resolvePendingInput({
      stepInput: {
        context: [context],
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.messages.at(-1)?.role).toBe("tool");
    expect(hasDeferredStepInput(result.session)).toBe(true);

    const deferred = consumeDeferredStepInput({ session: result.session });
    expect(deferred.input).toEqual({ context: [context] });
    expect(hasDeferredStepInput(deferred.session)).toBe(false);
  });

  it("resolves approval when follow-up text matches an option", () => {
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
      stepInput: { message: "approve" },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.deferredMessage).toBeUndefined();
    expect(result.consumedMessage).toBe(true);
    expect(result.messages.at(-1)).toEqual({
      content: [
        {
          approvalId: "approval-1",
          approved: true,
          reason: undefined,
          type: "tool-approval-response",
        },
      ],
      role: "tool",
    });
    expect(getApprovedTools(result.session).has("bash")).toBe(true);
    expect(hasDeferredStepInput(result.session)).toBe(false);
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
          reason: "Tool execution was denied.",
          type: "tool-approval-response",
        },
        {
          output: { type: "execution-denied", reason: "Tool execution was denied." },
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
            approval: {
              requestId: "approval-1",
              status: "denied",
            },
            code: "TOOL_EXECUTION_DENIED",
            message: "Tool execution was denied.",
            tool: {
              result: "not_run",
            },
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

  it("keeps a pending approval and queues an unrelated follow-up message", () => {
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

    expect(result.outcome).toBe("unresolved");
    expect(result.rejectedActions).toBeUndefined();
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
    expect(hasDeferredStepInput(result.session)).toBe(true);

    const deferred = consumeDeferredStepInput({ session: result.session });
    expect(deferred.input).toEqual({
      message: "Never mind, do something else.",
    });
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
    // survive on session.state across the park, so approval returns
    // "not-applicable" and the user is never asked to approve a second time.
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
          approval: once(),
        },
      ],
    ]);

    const rebuilt = buildToolSet({
      approvedTools: getApprovedTools(result.session),
      tools,
    });
    const approval = buildToolApproval(rebuilt);
    if (typeof approval !== "function") throw new TypeError("Expected generic approval function.");

    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "sess-test",
      turn: { id: "turn-test", sequence: 0 },
    });

    return expect(
      contextStorage.run(ctx, () =>
        approval({
          messages: [],
          runtimeContext: {},
          toolCall: {
            input: {},
            toolCallId: "call-1",
            toolName: "linear_whoami",
          } as never,
          tools: rebuilt,
          toolsContext: {} as never,
        }),
      ),
    ).resolves.toBe("not-applicable");
  });
});

describe("resolvePendingInput with a session-limit continuation batch", () => {
  function createLimitBatchSession(): HarnessSession {
    return setPendingInputBatch({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          totalUsedTokens: 12,
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });
  }

  it("resolves a continue answer without appending tool messages", () => {
    const result = resolvePendingInput({
      session: createLimitBatchSession(),
      stepInput: {
        inputResponses: [{ optionId: "continue", requestId: "sess-test:limit:input:12" }],
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.limitContinuation).toEqual({ granted: true });
    // The prompt is harness-authored — no tool call exists in model history,
    // so resolution must not append a tool message.
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
  });

  it("resolves a stop answer as not granted", () => {
    const result = resolvePendingInput({
      session: createLimitBatchSession(),
      stepInput: {
        inputResponses: [{ optionId: "stop", requestId: "sess-test:limit:input:12" }],
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.limitContinuation).toEqual({ granted: false });
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
  });

  it("treats a plain follow-up message as ignoring the prompt", () => {
    const result = resolvePendingInput({
      session: createLimitBatchSession(),
      stepInput: { message: "also do this other thing" },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.limitContinuation).toBeUndefined();
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
  });
});
