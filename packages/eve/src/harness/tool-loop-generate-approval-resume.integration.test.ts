import { jsonSchema, type LanguageModel, type ModelMessage, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  dispatchDynamicToolEvent,
  preparePersistedStepDynamicToolMetadata,
} from "#context/dynamic-tool-lifecycle.js";
import type { OldSourceOffsetDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import {
  AuthKey,
  SessionKey,
  StepDynamicToolMetadataKey,
  TurnTaskStateKey,
} from "#context/keys.js";
import { attributeInputResponses } from "#execution/input-response-auth.js";
import { getApprovalAuditState } from "#harness/approval-candidates.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { InputRequest } from "#shared/input.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import { once } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

function textStreamResult(text: string): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { id: "answer", type: "text-start" },
        { delta: text, id: "answer", type: "text-delta" },
        { id: "answer", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage,
        },
      ] satisfies StreamPart[],
    }),
  };
}

function toolCallStreamResult(call: {
  readonly input: string;
  readonly toolCallId: string;
  readonly toolName: string;
}): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { ...call, type: "tool-call" },
        {
          finishReason: { raw: undefined, unified: "tool-calls" },
          type: "finish",
          usage,
        },
      ] satisfies StreamPart[],
    }),
  };
}

const toolCall = {
  input: { command: "pwd" },
  toolCallId: "call-1",
  toolName: "bash",
  type: "tool-call" as const,
};

const approvalRequest = {
  approvalId: "approval-1",
  toolCallId: toolCall.toolCallId,
  type: "tool-approval-request" as const,
};

const secondToolCall = {
  input: { command: "whoami" },
  toolCallId: "call-2",
  toolName: "bash",
  type: "tool-call" as const,
};

const secondApprovalRequest = {
  approvalId: "approval-2",
  toolCallId: secondToolCall.toolCallId,
  type: "tool-approval-request" as const,
};

function createBaseSession(history?: readonly ModelMessage[]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "generate-approval-resume-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Run a shell command.",
          inputSchema: { type: "object" },
          name: toolCall.toolName,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generate-approval-resume-session",
    history: [...(history ?? [{ content: "Run pwd.", role: "user" }])],
    sessionId: "generate-approval-resume-session",
  };
}

const pendingApprovalInputRequest: InputRequest = {
  action: {
    callId: toolCall.toolCallId,
    input: toolCall.input,
    kind: "tool-call",
    toolName: toolCall.toolName,
  },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Yes" },
    { id: "cancel", label: "No" },
  ],
  prompt: "Approve tool call: bash",
  requestId: approvalRequest.approvalId,
};

function createPendingApprovalSession(
  history?: readonly ModelMessage[],
  responseAuthorization = false,
): HarnessSession {
  return appendPendingInputBatch({
    requests: [pendingApprovalInputRequest],
    responseAuthRequiredRequestIds: responseAuthorization
      ? [approvalRequest.approvalId]
      : undefined,
    responseMessages: [
      {
        content: [toolCall, approvalRequest],
        role: "assistant",
      },
    ],
    session: createBaseSession(history),
  });
}

function createTwoPendingApprovalSession(): HarnessSession {
  return appendPendingInputBatch({
    requests: [
      {
        action: {
          callId: secondToolCall.toolCallId,
          input: secondToolCall.input,
          kind: "tool-call",
          toolName: secondToolCall.toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes" },
          { id: "cancel", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: secondApprovalRequest.approvalId,
      },
    ],
    responseMessages: [
      {
        content: [secondToolCall, secondApprovalRequest],
        role: "assistant",
      },
    ],
    session: createPendingApprovalSession(),
  });
}

function createApprovalContext(): ContextContainer {
  const responder = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "user-1",
    principalType: "user" as const,
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, responder);
  ctx.set(SessionKey, {
    auth: { current: responder, initiator: null },
    sessionId: "generate-approval-resume-session",
    turn: { id: "turn-1", sequence: 1 },
  });
  return ctx;
}

function createModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: "The command returned /workspace.", type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage,
      warnings: [],
    },
    modelId: "generate-approval-resume-model",
    provider: "eve-integration-mock",
  });
}

function createConfig(
  model: MockLanguageModelV4,
  execute: (input: unknown, options: unknown) => Promise<string>,
  approval?: HarnessToolDefinition["approval"],
): ToolLoopHarnessConfig {
  const tools: ToolLoopHarnessConfig["tools"] = new Map([
    [
      toolCall.toolName,
      {
        approval,
        description: "Run a shell command.",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
        name: toolCall.toolName,
        toModelOutput: (output) => {
          if (typeof output !== "string") {
            throw new TypeError("Expected the bash test tool to return a string.");
          }
          return { type: "text", value: `canonical:${output}` };
        },
      },
    ],
  ]);
  return {
    mode: "conversation",
    resolveModel: async (): Promise<LanguageModel> => model,
    tools,
  };
}

function findPart(
  messages: readonly ModelMessage[],
  type: "tool-approval-response" | "tool-call" | "tool-result",
): unknown {
  for (const message of messages) {
    if (
      (message.role !== "assistant" && message.role !== "tool") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const part = message.content.find((candidate) => candidate.type === type);
    if (part !== undefined) return part;
  }
  return undefined;
}

describe("tool loop generate approval resume (real AI SDK)", () => {
  it("authorizes and audits the operator while executing as the suspended caller", async () => {
    const ctx = createApprovalContext();
    const operator = {
      authenticator: "oidc",
      principalType: "service" as const,
      principalId: "operator",
      attributes: {},
    };
    const authorize = vi.fn(({ responder }: { responder: { principalId: string } }) => {
      expect(responder.principalId).toBe("operator");
      return { status: "allowed" as const };
    });
    const execute = vi.fn(async () => {
      expect(contextStorage.getStore()?.get(AuthKey)?.principalId).toBe("user-1");
      return "/workspace";
    });
    const session = createPendingApprovalSession(undefined, true);
    const attributed = attributeInputResponses({
      caller: ctx.get(AuthKey) ?? null,
      responder: operator,
      state: session.state,
      stepInput: {
        inputResponses: [{ requestId: approvalRequest.approvalId, optionId: "approve" }],
      },
    });
    ctx.set(AuthKey, attributed.caller);
    const runStep = createToolLoopHarness(
      createConfig(createModel(), execute, {
        request: () => "user-approval",
        response: authorize,
      }),
    );
    let result = await contextStorage.run(ctx, () => runStep(session, attributed.stepInput));
    while (typeof result.next === "function") {
      const { next, session: resumedSession } = result;
      result = await contextStorage.run(ctx, () => next(resumedSession));
    }
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ principalId: "operator" }),
        outcome: "allowed",
      }),
    ]);
  });

  it.each([
    { label: "direct", responseAuthorization: false },
    { label: "response-authorized", responseAuthorization: true },
  ])("keeps a migrated step callback binding through $label approval", async (testCase) => {
    const order: string[] = [];
    const executeCallback = vi.fn(async (closure: unknown) => {
      const version = (closure as { version: string }).version;
      order.push(`execute:${version}`);
      return "/workspace";
    });
    const approvalResponseCallback = vi.fn(async (closure: unknown) => {
      const version = (closure as { version: string }).version;
      order.push(`authorize:${version}`);
      return { status: "allowed" as const };
    });
    const handler = vi.fn((event: { data?: { stepIndex?: number; turnId?: string } }) => {
      order.push(`resolve:${String(event.data?.turnId)}:${String(event.data?.stepIndex)}`);
      return {
        bash: defineTool({
          approval: {
            request: stampDurableDynamicCallback(() => "user-approval" as const, {
              callback: () => "user-approval" as const,
              closure: { version: "current-request" },
            }),
            response: stampDurableDynamicCallback(() => ({ status: "allowed" as const }), {
              callback: approvalResponseCallback,
              closure: { version: "current-response" },
            }),
          },
          description: "Run a shell command.",
          execute: stampDurableDynamicCallback(async () => "/current-workspace", {
            callback: executeCallback,
            closure: { version: "current-execute" },
          }),
          inputSchema: { type: "object" },
        }),
      };
    });
    const resolver = {
      eventNames: ["step.started"],
      events: {
        "step.started": handler,
      },
      logicalPath: "agent/tools/bash.ts",
      slug: "legacy",
      sourceId: "test:legacy-bash",
      sourceKind: "module",
    } as never;
    const ctx = new ContextContainer();
    const responder = {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user" as const,
    };
    ctx.set(AuthKey, responder);
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: null },
      sessionId: "generate-approval-resume-session",
      turn: { id: "turn-1", sequence: 1 },
    });
    ctx.set(StepDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: {
            closure: { version: "persisted-request" },
            stepId: "eve:dynamic-tool//old/approval-request/0-100",
          },
          approvalResponse: {
            closure: { version: "persisted-response" },
            stepId: "eve:dynamic-tool//old/approval-response/0-100",
          },
          execute: {
            closure: { version: "persisted-execute" },
            stepId: "eve:dynamic-tool//old/execute/0-100",
          },
        },
        description: "Old shell tool.",
        entryKey: "bash",
        inputSchema: { type: "object" },
        name: "bash",
        resolverSlug: "legacy",
      } satisfies OldSourceOffsetDynamicToolMetadata,
    ]);

    const model = new MockLanguageModelV4({
      doStream: textStreamResult("The command completed."),
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const config = {
      handleEvent: async (event, messages) => {
        await dispatchDynamicToolEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: [resolver],
        });
        if (event.type === "step.started") {
          const metadata = ctx.get(StepDynamicToolMetadataKey) ?? [];
          const version = (
            metadata[0]?.callbacks?.execute?.closure as { version?: string } | undefined
          )?.version;
          order.push(`step.started:${String(version)}`);
        }
      },
      mode: "conversation",
      resolveStepDynamicTools: (input) =>
        preparePersistedStepDynamicToolMetadata({ ...input, resolvers: [resolver] }),
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    } satisfies ToolLoopHarnessConfig;
    const session = setHarnessEmissionState(
      createPendingApprovalSession(undefined, testCase.responseAuthorization),
      {
        sequence: 1,
        sessionStarted: true,
        stepIndex: 1,
        turnId: "turn-1",
      },
    );
    const runStep = createToolLoopHarness(config);

    const first = await contextStorage.run(ctx, () =>
      runStep(session, {
        attributedInputResponses: [
          {
            auth: responder,
            response: { optionId: "approve", requestId: approvalRequest.approvalId },
          },
        ],
      }),
    );
    if (testCase.responseAuthorization) {
      if (typeof first.next !== "function") {
        throw new TypeError("Expected response authorization to schedule a continuation.");
      }
      const next = first.next;
      await contextStorage.run(ctx, () => next(first.session));
    } else {
      expect(first.next).toBeNull();
    }

    expect(order).toEqual(
      testCase.responseAuthorization
        ? [
            "resolve:turn-1:1",
            "authorize:persisted-response",
            "step.started:persisted-execute",
            "execute:persisted-execute",
          ]
        : ["resolve:turn-1:1", "step.started:persisted-execute", "execute:persisted-execute"],
    );
    expect(handler).toHaveBeenCalledOnce();
    if (testCase.responseAuthorization) {
      expect(approvalResponseCallback).toHaveBeenCalledWith(
        { version: "persisted-response" },
        expect.anything(),
      );
    } else {
      expect(approvalResponseCallback).not.toHaveBeenCalled();
    }
    expect(executeCallback).toHaveBeenCalledWith(
      { version: "persisted-execute" },
      toolCall.input,
      expect.objectContaining({ callId: toolCall.toolCallId }),
    );
    const metadata = ctx.get(StepDynamicToolMetadataKey) ?? [];
    expect(metadata[0]?.callbacks?.execute).toEqual({
      closure: { version: "persisted-execute" },
    });
  });

  it("does not resolve removed dynamic tools when an approval is cancelled", async () => {
    const responder = {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const ctx = new ContextContainer();
    ctx.set(AuthKey, responder);
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: null },
      sessionId: "generate-approval-resume-session",
      turn: { id: "turn-1", sequence: 1 },
    });
    ctx.set(StepDynamicToolMetadataKey, [
      {
        callbacks: {
          execute: {
            closure: { version: "persisted-execute" },
            stepId: "eve:dynamic-tool//old/execute/0-100",
          },
        },
        description: "Removed shell tool.",
        entryKey: "bash",
        inputSchema: { type: "object" },
        name: "bash",
        resolverSlug: "removed",
      } satisfies OldSourceOffsetDynamicToolMetadata,
    ]);
    const execute = vi.fn(async () => "/workspace");
    const resolveStepDynamicTools = vi.fn((input) =>
      preparePersistedStepDynamicToolMetadata({ ...input, resolvers: [] }),
    );
    const runStep = createToolLoopHarness({
      ...createConfig(createModel(), execute),
      resolveStepDynamicTools,
    });

    await expect(
      contextStorage.run(ctx, () =>
        runStep(createPendingApprovalSession(undefined, true), {
          attributedInputResponses: [
            {
              auth: responder,
              response: { optionId: "cancel", requestId: approvalRequest.approvalId },
            },
          ],
        }),
      ),
    ).resolves.toBeDefined();

    expect(resolveStepDynamicTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes two approvals delivered together exactly once each", async () => {
    const execute = vi.fn(async (input: unknown) =>
      (input as { command: string }).command === "pwd" ? "/workspace" : "eve",
    );
    const model = createModel();

    const first = await createToolLoopHarness(createConfig(model, execute))(
      createTwoPendingApprovalSession(),
      {
        inputResponses: [
          { optionId: "approve", requestId: approvalRequest.approvalId },
          { optionId: "approve", requestId: secondApprovalRequest.approvalId },
        ],
      },
    );
    if (typeof first.next !== "function") {
      throw new TypeError("Expected the deferred approval to schedule another harness step.");
    }
    const result = await first.next(first.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      secondToolCall.input,
      expect.objectContaining({ toolCallId: secondToolCall.toolCallId }),
    );

    const toolResultCallIds = result.session.history.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
        : [],
    );
    expect(toolResultCallIds).toEqual([toolCall.toolCallId, secondToolCall.toolCallId]);
  });

  // Regression: approving one once()-gated call recorded the grant immediately,
  // so a new same-tool call proposed on the resume step executed without a
  // prompt while the other parked card was still visible to the user.
  it("keeps prompting a once() tool while a sibling approval is still pending", async () => {
    const thirdToolCall = {
      input: JSON.stringify({ command: "ls" }),
      toolCallId: "call-3",
      toolName: "bash",
    };
    const execute = vi.fn(async () => "/workspace");
    const model = new MockLanguageModelV4({
      doStream: async () => toolCallStreamResult(thirdToolCall),
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const requested: InputRequest[] = [];
    const config = {
      ...createConfig(model, execute, once()),
      handleEvent: async (event) => {
        if (event.type === "input.requested") requested.push(...event.data.requests);
      },
    } satisfies ToolLoopHarnessConfig;

    const result = await contextStorage.run(createApprovalContext(), () =>
      createToolLoopHarness(config)(createTwoPendingApprovalSession(), {
        inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      }),
    );

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    expect(requested.map((request) => request.action.callId)).toEqual([thirdToolCall.toolCallId]);
    expect(result.next).toBeNull();
    const pendingCallIds = getPendingInputBatches(result.session.state).flatMap((batch) =>
      batch.requests.map((request) => request.action.callId),
    );
    expect(pendingCallIds).toEqual([secondToolCall.toolCallId, thirdToolCall.toolCallId]);
  });

  it("auto-allows a once() tool after every pending approval with its key is settled", async () => {
    const thirdToolCall = {
      input: JSON.stringify({ command: "ls" }),
      toolCallId: "call-3",
      toolName: "bash",
    };
    const execute = vi.fn(async () => "/workspace");
    // Batches settle one per step, so the model is called between them. It
    // proposes the third call only once both pending prompts are gone.
    const responses = [
      textStreamResult("Ran pwd."),
      toolCallStreamResult(thirdToolCall),
      textStreamResult("All done."),
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("Unexpected extra model call.");
        return next;
      },
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const requested: InputRequest[] = [];
    const config = {
      ...createConfig(model, execute, once()),
      handleEvent: async (event) => {
        if (event.type === "input.requested") requested.push(...event.data.requests);
      },
    } satisfies ToolLoopHarnessConfig;
    const ctx = createApprovalContext();
    const runStep = createToolLoopHarness(config);

    const first = await contextStorage.run(ctx, () =>
      runStep(createTwoPendingApprovalSession(), {
        inputResponses: [
          { optionId: "approve", requestId: approvalRequest.approvalId },
          { optionId: "cancel", requestId: secondApprovalRequest.approvalId },
        ],
      }),
    );
    // The second batch's denial replays on a deferred step; drain until the turn settles.
    if (typeof first.next !== "function") {
      throw new TypeError("Expected the deferred approval response to schedule another step.");
    }
    let result = first;
    while (typeof result.next === "function") {
      const { next, session } = result;
      result = await contextStorage.run(ctx, () => next(session));
    }

    expect(requested).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { command: "ls" },
      expect.objectContaining({ toolCallId: thirdToolCall.toolCallId }),
    );
    expect(responses).toEqual([]);
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "All done.", type: "text" }],
      role: "assistant",
    });
  });

  it("executes an approval before replaying its message after a limit continuation", async () => {
    const execute = vi.fn(async () => "/workspace");
    const model = new MockLanguageModelV4({
      doStream: [textStreamResult("The command completed."), textStreamResult("Summary complete.")],
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const config = {
      ...createConfig(model, execute),
      handleEvent: async () => {},
    } satisfies ToolLoopHarnessConfig;
    const usageState = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 3,
      sawCost: false,
    };
    const session = setTurnUsageState(
      {
        ...createPendingApprovalSession(),
        limits: { maxInputTokensPerSession: 12 },
      },
      { ...usageState, session: usageState, turnId: "turn_previous" },
    );
    const runStep = createToolLoopHarness(config);

    const limited = await runStep(session, {
      inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      message: "Then summarize it.",
    });

    expect(execute).not.toHaveBeenCalled();
    const resumed = await runStep(limited.session, {
      inputResponses: [
        {
          optionId: "continue",
          requestId: `${session.sessionId}:limit:input:12`,
        },
      ],
    });

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    expect(typeof resumed.next).toBe("function");
    if (typeof resumed.next !== "function") {
      throw new TypeError("Expected the deferred message to run after approval execution.");
    }
    await resumed.next(resumed.session);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.prompt.at(-1)?.role).toBe("tool");
    expect(model.doStreamCalls[1]?.prompt.at(-1)).toMatchObject({
      content: [{ text: "Then summarize it.", type: "text" }],
      role: "user",
    });
  });

  it("persists the approved pre-model tool result without an event handler", async () => {
    const execute = vi.fn(async () => "/workspace");
    const model = createModel();

    const result = await createToolLoopHarness(createConfig(model, execute))(
      createPendingApprovalSession(),
      {
        inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(findPart(result.session.history, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });

  // Regression: turn-local context (task state, dynamic skill announcement) was
  // appended as a user message after the approval response. The AI SDK reads
  // approvals only from the tail tool message, so the approved tool never ran
  // and the provider rejected the prompt with a tool call that had no output.
  it.each([
    { key: PendingSkillAnnouncementKey, label: "dynamic skill announcement" },
    { key: TurnTaskStateKey, label: "task state" },
  ])("executes the approved tool when $label is injected on the resume step", async ({ key }) => {
    const siblingCall = {
      input: { command: "whoami" },
      toolCallId: "call-sibling",
      toolName: "bash",
      type: "tool-call" as const,
    };
    const siblingResult = {
      output: { type: "text" as const, value: "eve" },
      toolCallId: siblingCall.toolCallId,
      toolName: "bash",
      type: "tool-result" as const,
    };
    const session = appendPendingInputBatch({
      requests: [pendingApprovalInputRequest],
      // The parked shape when a gated call shares a step with an ungated one.
      responseMessages: [
        { content: [toolCall, approvalRequest, siblingCall], role: "assistant" },
        { content: [siblingResult], role: "tool" },
      ],
      session: createBaseSession(),
    });
    const ctx = new ContextContainer();
    ctx.set(key, "[Runtime context]\nInjected on the resume step.");
    const execute = vi.fn(async () => "/workspace");
    const model = createModel();

    const result = await contextStorage.run(ctx, () =>
      createToolLoopHarness(createConfig(model, execute))(
        setHarnessEmissionState(session, {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 1,
          turnId: "turn-1",
        }),
        { inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }] },
      ),
    );

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    const answered = new Set<string>();
    const called: string[] = [];
    for (const message of providerPrompt) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === "tool-call") called.push(part.toolCallId);
        if (part.type === "tool-result") answered.add(part.toolCallId);
      }
    }
    expect(called).toEqual([toolCall.toolCallId, siblingCall.toolCallId]);
    expect(called.filter((id) => !answered.has(id))).toEqual([]);
    expect(providerPrompt.at(-1)?.role).toBe("tool");
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });

  // Acceptance gate for the HITL non-blocking plan (research/hitl-request-lifecycle.md):
  // once messages run as normal turns while an approval is open, the approval batch is
  // restored *after* that intervening exchange. This proves the AI SDK accepts the
  // late-spliced transcript shape before any behavior change lands.
  it("splices the approved batch after an intervening conversation turn", async () => {
    const interveningHistory: readonly ModelMessage[] = [
      { content: "Run pwd.", role: "user" },
      { content: "Any update on that command?", role: "user" },
      {
        content: [{ text: "Still waiting for approval to run pwd.", type: "text" }],
        role: "assistant",
      },
    ];
    const execute = vi.fn(async () => "/workspace");
    const model = createModel();

    const result = await createToolLoopHarness(createConfig(model, execute))(
      createPendingApprovalSession(interveningHistory),
      {
        inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
      },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    // The provider prompt keeps the intervening turn before the restored batch.
    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    const interveningIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Any update"),
    );
    const toolCallIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call"),
    );
    expect(interveningIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeGreaterThan(interveningIndex);
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    // Committed history: intervening exchange first, then the restored batch, exactly once.
    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });
});
