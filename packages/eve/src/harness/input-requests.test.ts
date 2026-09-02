import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { once } from "#tools/approval/policies.js";
import type { InputRequest } from "#shared/input.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  clearPendingSessionLimitPrompt,
  createRuntimeToolCallActionFromToolCall,
  createRequests,
  getApprovedTools,
  hasOpenRequests,
  hasStepInput,
} from "#harness/input-requests.js";
import { recordApprovedToolKeys } from "#harness/hitl/approval-input-requests.js";
import {
  consumeDeferredStepInput,
  hasDeferredStepInput,
  queueDeferredStepInput,
} from "#harness/hitl/deferred-step-input.js";
import { interpretRequests } from "#harness/hitl/request-interpreter.js";
import {
  acknowledgeReadyRequestGroupDelivery,
  commitRequestLedger,
  openRequestIds,
  readRequestLedger,
  type GroupCompletion,
} from "#harness/hitl/request-ledger.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { buildToolApproval, buildToolSet } from "#harness/tools.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";

async function resolvePendingInput(input: {
  session: HarnessSession;
  stepInput?: StepInput;
  deferMessagesWhileApprovalsPending?: boolean;
  resolveApprovalKey?: (request: InputRequest) => string | undefined;
  policies?: HarnessToolMap;
  responder?: import("#channel/types.js").SessionAuthContext | null;
}): Promise<{
  outcome: "resolved" | "continue" | "unresolved";
  messages: ModelMessage[];
  session: HarnessSession;
  deferredMessage?: boolean;
  deferredContext?: boolean;
  consumedMessage?: boolean;
  rejectedActions?: Extract<
    GroupCompletion,
    { owner: "framework-approval-gate" }
  >["rejectedActions"];
  limitContinuation?: Extract<GroupCompletion, { owner: "session-turn" }>["limitContinuation"];
  completions?: GroupCompletion[];
}> {
  const now = 1234567890;
  const ledger = readRequestLedger(input.session.state);
  const interpreted = await interpretRequests({
    deferMessagesWhileApprovalsPending: input.deferMessagesWhileApprovalsPending ?? false,
    delivery: {
      authorizationResults: [],
      now,
      responder: input.responder ?? null,
      stepInput: input.stepInput,
    },
    history: input.session.history,
    ledger,
    policies: input.policies ?? new Map(),
    resolveApprovalKey: input.resolveApprovalKey,
  });

  let session = commitRequestLedger(input.session, interpreted.ledger, ledger.version);
  let limitContinuation: { readonly granted: boolean } | undefined;
  let rejectedActions:
    | Extract<GroupCompletion, { owner: "framework-approval-gate" }>["rejectedActions"]
    | undefined;

  if (interpreted.kind === "wait") {
    if (interpreted.heldInput !== undefined) {
      session = queueDeferredStepInput(session, interpreted.heldInput);
    }
    return {
      messages: [...input.session.history],
      outcome: "unresolved",
      session,
    };
  }

  if (interpreted.kind === "complete") {
    for (const completion of interpreted.completions) {
      if (completion.owner === "framework-approval-gate") {
        session = recordApprovedToolKeys(session, completion.approvedToolKeys);
        if (completion.rejectedActions.length > 0) {
          rejectedActions = completion.rejectedActions;
        }
      } else {
        limitContinuation = completion.limitContinuation ?? limitContinuation;
      }
    }
    session = acknowledgeReadyRequestGroupDelivery({
      deliveryKey: interpreted.deliveryKey,
      session,
    });
  }

  if (interpreted.stepInput !== undefined) {
    session = queueDeferredStepInput(session, interpreted.stepInput);
  }

  return {
    completions: interpreted.kind === "complete" ? [...interpreted.completions] : undefined,
    consumedMessage: interpreted.messageConsumed === true ? true : undefined,
    deferredContext:
      interpreted.stepInput?.context !== undefined ||
      (interpreted.stepInput as { clientContext?: unknown } | undefined)?.clientContext !==
        undefined
        ? true
        : undefined,
    deferredMessage: interpreted.stepInput?.message !== undefined ? true : undefined,
    limitContinuation,
    messages:
      interpreted.kind === "complete"
        ? [...interpreted.completions.at(-1)!.messages]
        : [...interpreted.messages],
    outcome: interpreted.kind === "continue" ? "continue" : "resolved",
    rejectedActions,
    session,
  };
}

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
  it("keeps approvals pending when another request is answered first", async () => {
    const session = createRequests({
      requests: [
        {
          action: {
            callId: "question-call",
            input: { prompt: "Pick one." },
            kind: "tool-call",
            toolName: "ask_question",
          },
          display: "select",
          kind: "question",
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
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

  it("resolves freeform question input from a follow-up message", async () => {
    const session = createRequests({
      requests: [
        {
          action: {
            callId: "question-call",
            input: { prompt: "Pick one." },
            kind: "tool-call",
            toolName: "ask_question",
          },
          display: "text",
          kind: "question",
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

    const result = await resolvePendingInput({
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

  it("defers a follow-up message until after tool approvals are resolved", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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
    const result = await resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "cancel" }],
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

  it("defers channel context until after tool approvals are resolved", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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
    const result = await resolvePendingInput({
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

  it("resolves approval when follow-up text matches an option", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
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

  it("records compound approval key when resolveApprovalKey is provided", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
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

  it("emits a matching execution-denied tool-result when the user explicitly denies an approval", async () => {
    /*
     * AI SDK's `streamText` synthesizes an `execution-denied`
     * tool-result for the current turn only — on subsequent turns the
     * persisted `tool-approval-response` gets stripped during provider
     * prompt conversion, leaving the prior `tool_use` block
     * unmatched. The harness must emit the matching tool-result
     * itself so persisted history is replay-safe.
     */
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "cancel" }],
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

  it("returns a rejected action for an ACP denial", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = await resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toEqual([
      {
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
      },
    ]);
    expect(result.completions).toMatchObject([
      {
        owner: "framework-approval-gate",
        rejectedActions: [
          {
            event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
          },
        ],
      },
    ]);
  });

  it("does not return a rejected action when an approval is granted", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = await resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toBeUndefined();
    expect(result.completions).toMatchObject([{ owner: "framework-approval-gate" }]);
  });

  it("does not retain approval when a deferred response is superseded", async () => {
    const approval = (requestId: string, callId: string): InputRequest => ({
      action: { callId, input: { command: "pwd" }, kind: "tool-call", toolName: "bash" },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId,
    });
    const session = createRequests({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [approval("approval-1", "call-1"), approval("approval-2", "call-2")],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const partial = await resolvePendingInput({
      session,
      stepInput: { inputResponses: [{ requestId: "approval-1", optionId: "approve" }] },
    });
    const deferred = consumeDeferredStepInput({
      input: {
        inputResponses: [
          { requestId: "approval-1", optionId: "cancel" },
          { requestId: "approval-2", optionId: "approve" },
        ],
      },
      session: partial.session,
    });
    const result = await resolvePendingInput({
      resolveApprovalKey: (request) => request.requestId,
      session: deferred.session,
      stepInput: deferred.input,
    });

    expect(getApprovedTools(result.session)).toEqual(new Set(["approval-2"]));
    expect(result.rejectedActions?.[0]?.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
      }),
    ]);
  });

  it("keeps a pending approval open while an unrelated follow-up message continues", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = await resolvePendingInput({
      stepInput: { message: "Never mind, do something else." },
      session,
    });

    // The message runs as an ordinary turn; the approval stays answerable.
    expect(result.outcome).toBe("continue");
    expect(result.rejectedActions).toBeUndefined();
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
    expect(hasDeferredStepInput(result.session)).toBe(false);
    expect(openRequestIds(result.session.state)).toEqual(new Set(["approval-1"]));
  });

  it("preserves context-only input while a pending batch stays open", async () => {
    const session = createRequests({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          kind: "tool-approval",
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = await resolvePendingInput({
      session,
      stepInput: { context: ["channel context"] },
    });
    const deferred = consumeDeferredStepInput({ session: result.session });

    expect(result.outcome).toBe("unresolved");
    expect(deferred.input).toEqual({ context: ["channel context"] });
  });

  it("falls back to tool name when no approvalKey is provided", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    const approved = getApprovedTools(result.session);
    expect(approved.has("bash")).toBe(true);
  });

  it("approval survives the authorization park so an auth+approval tool is not approved twice", async () => {
    // A tool requiring both approval and auth is approved first, then its
    // execute parks for sign-in. On resume the step re-runs and the toolset
    // is rebuilt from the persisted approvedTools. The recorded approval must
    // survive on session.state across the park, so approval returns
    // "not-applicable" and the user is never asked to approve a second time.
    // See research/per-tool-auth-known-issues.md, issue 3.
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
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

    const result = await resolvePendingInput({
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

describe("pending input batch collection", () => {
  function approvalRequest(requestId: string, callId: string): InputRequest {
    return {
      action: { callId, input: { command: "pwd" }, kind: "tool-call", toolName: "bash" },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId,
    };
  }

  function questionRequest(requestId: string, callId: string): InputRequest {
    return {
      action: {
        callId,
        input: { prompt: "Pick one." },
        kind: "tool-call",
        toolName: "ask_question",
      },
      display: "select",
      kind: "question",
      options: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
      prompt: "Pick one.",
      requestId,
    };
  }

  function batchOutput(callId: string, toolName: string): ModelMessage {
    return {
      content: [{ input: {}, toolCallId: callId, toolName, type: "tool-call" }],
      role: "assistant",
    };
  }

  it("reads a legacy singleton batch and rewrites it as a list", async () => {
    const legacySession: HarnessSession = {
      ...createHarnessSession(),
      state: {
        "eve.runtime.pendingInputBatch": {
          requests: [approvalRequest("approval-1", "call-1")],
          responseMessages: [batchOutput("call-1", "bash")],
        },
      },
    };

    expect(openRequestIds(legacySession.state)).toEqual(new Set(["approval-1"]));

    const appended = createRequests({
      requests: [questionRequest("question-1", "call-2")],
      responseMessages: [batchOutput("call-2", "ask_question")],
      session: legacySession,
    });
    expect(appended.state?.["eve.runtime.pendingInputBatch"]).toBeUndefined();
    expect(openRequestIds(appended.state)).toEqual(new Set(["approval-1", "question-1"]));

    const result = await resolvePendingInput({
      session: legacySession,
      stepInput: { inputResponses: [{ requestId: "approval-1", optionId: "approve" }] },
    });
    expect(result.outcome).toBe("resolved");
    expect(result.session.state?.["eve.runtime.pendingInputBatch"]).toBeUndefined();
    expect(hasOpenRequests(result.session.state)).toBe(false);
  });

  it("keeps earlier batches open while a later batch resolves", async () => {
    let session = createRequests({
      requests: [approvalRequest("approval-1", "call-1")],
      responseMessages: [batchOutput("call-1", "bash")],
      session: createHarnessSession(),
    });
    session = createRequests({
      requests: [questionRequest("question-1", "call-2")],
      responseMessages: [batchOutput("call-2", "ask_question")],
      session,
    });

    const answered = await resolvePendingInput({
      session,
      stepInput: { inputResponses: [{ requestId: "question-1", optionId: "red" }] },
    });
    expect(answered.outcome).toBe("resolved");
    expect(openRequestIds(answered.session.state)).toEqual(new Set(["approval-1"]));
    // Only the answered batch's withheld output is restored.
    expect(answered.messages).toEqual([
      { content: "previous", role: "user" },
      batchOutput("call-2", "ask_question"),
      {
        content: [
          {
            output: {
              type: "json",
              value: { optionId: "red", text: undefined, status: "answered" },
            },
            toolCallId: "call-2",
            toolName: "ask_question",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    const approved = await resolvePendingInput({
      session: answered.session,
      stepInput: { inputResponses: [{ requestId: "approval-1", optionId: "approve" }] },
    });
    expect(approved.outcome).toBe("resolved");
    expect(hasOpenRequests(approved.session.state)).toBe(false);
  });

  it("resolves only the first approval-bearing batch and defers later responses", async () => {
    let session = createRequests({
      requests: [approvalRequest("approval-1", "call-1")],
      responseMessages: [batchOutput("call-1", "bash")],
      session: createHarnessSession(),
    });
    session = createRequests({
      requests: [approvalRequest("approval-2", "call-2")],
      responseMessages: [batchOutput("call-2", "bash")],
      session,
    });

    const first = await resolvePendingInput({
      session,
      stepInput: {
        inputResponses: [
          { requestId: "approval-1", optionId: "approve" },
          { requestId: "approval-2", optionId: "approve" },
        ],
      },
    });

    expect(first.outcome).toBe("resolved");
    expect(first.messages).toEqual([
      { content: "previous", role: "user" },
      batchOutput("call-1", "bash"),
      {
        content: [
          {
            approvalId: "approval-1",
            approved: true,
            reason: undefined,
            type: "tool-approval-response",
          },
        ],
        role: "tool",
      },
    ]);
    expect(openRequestIds(first.session.state)).toEqual(new Set(["approval-2"]));

    const deferred = consumeDeferredStepInput({ session: first.session });
    expect(deferred.input).toEqual({
      inputResponses: [{ requestId: "approval-2", optionId: "approve" }],
    });

    const second = await resolvePendingInput({
      session: deferred.session,
      stepInput: deferred.input,
    });
    expect(second.outcome).toBe("resolved");
    expect(second.messages.at(-1)).toMatchObject({
      content: [{ approvalId: "approval-2", approved: true }],
      role: "tool",
    });
    expect(hasOpenRequests(second.session.state)).toBe(false);
  });

  it("leaves every batch open when a message arrives with several batches pending", async () => {
    let session = createRequests({
      requests: [approvalRequest("approval-1", "call-1")],
      responseMessages: [batchOutput("call-1", "bash")],
      session: createHarnessSession(),
    });
    session = createRequests({
      requests: [questionRequest("question-1", "call-2")],
      responseMessages: [batchOutput("call-2", "ask_question")],
      session,
    });

    const result = await resolvePendingInput({ session, stepInput: { message: "keep going" } });

    expect(result.outcome).toBe("continue");
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
    expect(hasDeferredStepInput(result.session)).toBe(false);
    expect(openRequestIds(result.session.state)).toEqual(new Set(["approval-1", "question-1"]));
  });
});

describe("resolvePendingInput with a session-limit continuation batch", () => {
  function approvalRequest(): InputRequest {
    return {
      action: { callId: "call-1", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId: "approval-1",
    };
  }

  function createLimitBatchSession(): HarnessSession {
    return createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });
  }

  it("rejects a session-limit batch containing a model-anchored request", async () => {
    const session = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
        approvalRequest(),
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    await expect(resolvePendingInput({ session })).rejects.toThrow(
      "Session-limit pending input batches must contain only session-limit requests.",
    );
  });

  it("resolves a continue answer without appending tool messages", async () => {
    const result = await resolvePendingInput({
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

  it("resolves a stop answer as not granted", async () => {
    const result = await resolvePendingInput({
      session: createLimitBatchSession(),
      stepInput: {
        inputResponses: [{ optionId: "stop", requestId: "sess-test:limit:input:12" }],
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.limitContinuation).toEqual({ granted: false });
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
  });

  it("keeps the prompt pending and queues a plain follow-up message", async () => {
    const result = await resolvePendingInput({
      session: createLimitBatchSession(),
      stepInput: { message: "also do this other thing" },
    });

    expect(result.outcome).toBe("unresolved");
    expect(result.limitContinuation).toBeUndefined();
    expect(result.messages).toEqual([{ content: "previous", role: "user" }]);
    expect(hasDeferredStepInput(result.session)).toBe(true);

    const deferred = consumeDeferredStepInput({ session: result.session });
    expect(deferred.input).toEqual({ message: "also do this other thing" });
  });

  it("matches text against the limit batch while an approval batch is also open", async () => {
    let session = createRequests({
      requests: [approvalRequest()],
      responseMessages: [],
      session: createHarnessSession(),
    });
    session = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ],
      responseMessages: [],
      session,
    });

    const result = await resolvePendingInput({ session, stepInput: { message: "continue" } });

    expect(result.outcome).toBe("resolved");
    expect(result.limitContinuation).toEqual({ granted: true });
    expect(result.consumedMessage).toBe(true);
    expect(openRequestIds(result.session.state)).toEqual(new Set(["approval-1"]));
    expect(hasDeferredStepInput(result.session)).toBe(false);
  });

  it("defers an approval response while the limit batch remains open", async () => {
    let session = createRequests({
      requests: [approvalRequest()],
      responseMessages: [],
      session: createHarnessSession(),
    });
    session = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ],
      responseMessages: [],
      session,
    });

    const result = await resolvePendingInput({
      session,
      stepInput: { inputResponses: [{ requestId: "approval-1", optionId: "approve" }] },
    });

    expect(result.outcome).toBe("unresolved");
    expect(openRequestIds(result.session.state)).toEqual(
      new Set(["approval-1", "sess-test:limit:input:12"]),
    );
    const deferred = consumeDeferredStepInput({ session: result.session });
    expect(deferred.input).toEqual({
      inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
    });
  });
});

describe("clearPendingSessionLimitPrompt", () => {
  it("drops a pending batch made only of session-limit continuation prompts", async () => {
    const session = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "sess-test",
          violation: { kind: "input", limit: 12, usedTokens: 12 },
        }),
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const cleared = clearPendingSessionLimitPrompt(session);
    const result = await resolvePendingInput({
      session: cleared,
      stepInput: { message: "try again" },
    });

    // No stale batch left: the follow-up message flows to the step (where
    // the pre-model gate re-raises the prompt) instead of deferring forever.
    expect(result.outcome).toBe("continue");
    expect(hasDeferredStepInput(cleared)).toBe(false);
  });

  it("keeps model-anchored batches (tool approvals) intact", async () => {
    const session = createRequests({
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
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const kept = clearPendingSessionLimitPrompt(session);
    const result = await resolvePendingInput({
      session: kept,
      stepInput: { message: "and then this" },
    });

    // The approval batch survives the limit-prompt sweep and stays
    // answerable; the follow-up message continues as an ordinary turn.
    expect(openRequestIds(result.session.state)).toEqual(new Set(["approval-1"]));
    expect(result.outcome).toBe("continue");
    expect(hasDeferredStepInput(result.session)).toBe(false);
  });

  it("is a no-op without a pending batch", async () => {
    const session = createHarnessSession();
    expect(clearPendingSessionLimitPrompt(session)).toBe(session);
  });
});
