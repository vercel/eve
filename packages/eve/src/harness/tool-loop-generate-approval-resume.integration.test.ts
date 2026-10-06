import {
  createApprovalContext,
  textStreamResult,
  toolCallStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { setTurnClientContextState } from "#harness/turn-client-context.js";
import { jsonSchema, type LanguageModel, type ModelMessage, type Telemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { InstrumentationAttemptScope } from "#instrumentation/lifecycle.js";
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
  HistoryStateKey,
  SessionKey,
  SessionIdKey,
  SessionDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
} from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { InputRequest } from "#shared/input.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { createToolLoopHarness as createHarness } from "#harness/tool-loop.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { StepFn } from "#harness/types.js";
import {
  foldingHandler,
  grantedKeys,
  parkedSteps,
  withOpenTurn,
  withParkedStep,
} from "#internal/testing/session-machine.js";

/** Runs each harness call as a durable step: a context that enters, and folds, the projection. */
function createToolLoopHarness(config: ToolLoopHarnessConfig): StepFn {
  const harness = createHarness({ ...config, handleEvent: foldingHandler(config.handleEvent) });
  const step: StepFn = async (session, input) => {
    const ctx =
      (contextStorage.getStore() as ContextContainer | undefined) ?? createApprovalContext();
    enterSessionProjection(ctx, session.state);
    const result = await contextStorage.run(ctx, () => harness(session, input));
    return { ...result, next: typeof result.next === "function" ? step : result.next };
  };
  return step;
}
import { openInputs } from "#protocol/session-projection.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import { once } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";
import { z } from "#compiled/zod/index.js";
import {
  registerDurableDynamicCallback,
  stampDurableDynamicCallback,
} from "#tools/durable-callbacks.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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

function createBaseSession(history?: readonly HarnessModelMessage[]): HarnessSession {
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
    history: [...(history ?? [{ content: "Run pwd.", kind: "user" as const, role: "user" }])],
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
  history?: readonly HarnessModelMessage[],
  responseAuthorization = false,
): HarnessSession {
  return withParkedStep(createBaseSession(history), {
    event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
    messages: [{ content: [toolCall, approvalRequest], role: "assistant" }],
    requests: [pendingApprovalInputRequest],
    responseAuthRequiredRequestIds: responseAuthorization
      ? [approvalRequest.approvalId]
      : undefined,
  });
}

function createTwoPendingApprovalSession(): HarnessSession {
  return withParkedStep(createPendingApprovalSession(), {
    event: { sequence: 2, stepIndex: 0, turnId: "turn-2" },
    messages: [{ content: [secondToolCall, secondApprovalRequest], role: "assistant" }],
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
  });
}

function createModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: textStreamResult("The command returned /workspace."),
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
  it.each(
    [
      { scope: "step", metadataKey: StepDynamicToolMetadataKey },
      { scope: "turn", metadataKey: TurnDynamicToolMetadataKey },
      { scope: "session", metadataKey: SessionDynamicToolMetadataKey },
    ].flatMap((scope) => ["structured", "text"].map((response) => ({ ...scope, response }))),
  )(
    "records the scoped key for a $response approval of a $scope dynamic tool",
    async ({ metadataKey, response, scope }) => {
      const ctx = createApprovalContext();
      const execute = vi.fn(async () => "/workspace");
      const owner = {
        sessionId: ctx.require(SessionIdKey),
        scope: scope as "session" | "turn" | "step",
        resolverSlug: "dynamic-shell",
        entryKey: "bash",
        name: "bash",
      };
      registerDurableDynamicCallback({ owner, phase: "execute", callback: execute });
      registerDurableDynamicCallback({
        owner,
        phase: "approvalKey",
        callback: (_closure, input: { command: string }) => `bash:${input.command}`,
      });
      ctx.set(metadataKey, [
        {
          name: "bash",
          description: "Run a shell command.",
          inputSchema: { type: "object" },
          resolverSlug: "dynamic-shell",
          entryKey: "bash",
          callbacks: { execute: { closure: {} }, approvalKey: { closure: {} } },
        },
      ]);
      const staticExecute = vi.fn(async () => "static");
      const resolveStepDynamicTools = vi.fn(async () => {});
      const runStep = createToolLoopHarness({
        ...createConfig(createModel(), staticExecute),
        resolveStepDynamicTools,
      });

      const result = await contextStorage.run(ctx, () =>
        runStep(
          createPendingApprovalSession(),
          response === "text"
            ? { message: "approve" }
            : {
                inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
              },
        ),
      );
      expect(resolveStepDynamicTools).toHaveBeenCalledOnce();

      expect(grantedKeys(result.session)).toEqual(new Set(["bash:pwd"]));
      expect(execute).toHaveBeenCalledOnce();
      expect(staticExecute).not.toHaveBeenCalled();
    },
  );

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
    ctx.set(SessionIdKey, "generate-approval-resume-session");
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
      resolveStepDynamicTools: (input) =>
        preparePersistedStepDynamicToolMetadata({ ...input, resolvers: [resolver] }),
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    } satisfies ToolLoopHarnessConfig;
    const session = withOpenTurn(
      createPendingApprovalSession(undefined, testCase.responseAuthorization),
      { sequence: 1, stepIndex: 1, turnId: "turn-1" },
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

    // The approving step's tools are restored at its coordinates. The next model step starts and
    // resolves its own, then the approved call runs with the approving step's persisted binding,
    // where the AI SDK ran it: after the step started, before the model call.
    expect(order).toEqual(
      testCase.responseAuthorization
        ? [
            "resolve:turn-1:0",
            "authorize:persisted-response",
            "resolve:turn-1:2",
            "step.started:current-execute",
            "execute:persisted-execute",
          ]
        : [
            "resolve:turn-1:0",
            "resolve:turn-1:2",
            "step.started:current-execute",
            "execute:persisted-execute",
          ],
    );
    expect(handler).toHaveBeenCalledTimes(2);
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
    // The model step that follows resolved its own step tools.
    const metadata = ctx.get(StepDynamicToolMetadataKey) ?? [];
    expect(metadata[0]?.callbacks?.execute).toEqual({
      closure: { version: "current-execute" },
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
    ctx.set(SessionIdKey, "generate-approval-resume-session");
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

  it("executes approved siblings concurrently and exactly once each", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    const execute = vi.fn(async (input: unknown) => {
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      return (input as { command: string }).command === "pwd" ? "/workspace" : "eve";
    });
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
    const result = first;
    expect(model.doStreamCalls).toHaveLength(1);
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

  it("does not execute approved input rejected by the restored tool schema", async () => {
    const execute = vi.fn(async () => "unexpected");
    const model = createModel();
    const config = createConfig(model, execute);
    const definition = config.tools.get("bash")!;
    const tools = new Map(config.tools);
    tools.set("bash", {
      ...definition,
      inputSchema: defineJsonSchema({
        type: "object",
        required: ["command"],
        properties: { command: { type: "number" } },
      }),
    });
    const result = await createToolLoopHarness({ ...config, tools })(
      createPendingApprovalSession(),
      { inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }] },
    );
    expect(execute).not.toHaveBeenCalled();
    const output = findPart(result.session.history, "tool-result");
    expect(output).toMatchObject({
      toolCallId: toolCall.toolCallId,
      output: { type: "error-text", value: expect.stringContaining("no longer valid") },
    });
  });

  it("does not execute approved input that fails a refinement of the restored tool schema", async () => {
    const execute = vi.fn(async () => "unexpected");
    const config = createConfig(createModel(), execute);
    const tools = new Map(config.tools);
    tools.set("bash", {
      ...tools.get("bash")!,
      inputSchema: z.strictObject({
        command: z.string().refine((command) => !command.includes(".."), "Stay in the workspace."),
      }),
    });
    const input = { command: "cat ../notes.txt" };
    const session = withParkedStep(createBaseSession(), {
      event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
      messages: [{ content: [{ ...toolCall, input }, approvalRequest], role: "assistant" }],
      requests: [
        {
          ...pendingApprovalInputRequest,
          action: { ...pendingApprovalInputRequest.action, input },
        },
      ],
    });
    const result = await createToolLoopHarness({ ...config, tools })(session, {
      inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(findPart(result.session.history, "tool-result")).toMatchObject({
      toolCallId: toolCall.toolCallId,
      output: { type: "error-text", value: expect.stringContaining("no longer valid") },
    });
  });

  it("keeps completed sibling results when another output mapper fails", async () => {
    const execute = vi.fn(async (input: unknown) => (input as { command: string }).command);
    const config = createConfig(createModel(), execute);
    const tools = new Map(config.tools);
    tools.set("bash", {
      ...tools.get("bash")!,
      toModelOutput: (output: unknown) => {
        if (output === "whoami") throw new Error("Bob's output could not be formatted.");
        return { type: "text", value: String(output) };
      },
    });
    const session = withParkedStep(createBaseSession(), {
      event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
      messages: [
        {
          content: [toolCall, approvalRequest, secondToolCall, secondApprovalRequest],
          role: "assistant",
        },
      ],
      requests: [
        pendingApprovalInputRequest,
        {
          ...pendingApprovalInputRequest,
          action: {
            ...pendingApprovalInputRequest.action,
            callId: secondToolCall.toolCallId,
            input: secondToolCall.input,
          },
          requestId: secondApprovalRequest.approvalId,
        },
      ],
    });
    const result = await createToolLoopHarness({ ...config, tools })(session, {
      inputResponses: [
        { optionId: "approve", requestId: approvalRequest.approvalId },
        { optionId: "approve", requestId: secondApprovalRequest.approvalId },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const parts = result.session.history.flatMap((message) =>
      message.role === "tool" ? message.content : [],
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ toolCallId: "call-1", output: { type: "text", value: "pwd" } }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        toolCallId: "call-2",
        output: { type: "error-text", value: "Bob's output could not be formatted." },
      }),
    );
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
    const pendingCallIds = parkedSteps(result.session).flatMap((step) =>
      step.requests.map((request) => request.action.callId),
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
    const responses = [toolCallStreamResult(thirdToolCall), textStreamResult("All done.")];
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
      capabilities: { requestInput: true },
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

    // Over budget, the approved call waits for the grant, as the model call does.
    expect(execute).not.toHaveBeenCalled();
    const resumed = await runStep(limited.session, {
      inputResponses: [
        {
          optionId: "continue",
          requestId: openInputs(storedProjection(limited.session.state))[0]!.request.requestId,
        },
      ],
    });

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    // The model reads the approved call's result first; the message replays in the next step.
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

  it("reports an approved call's execution within the step's first attempt, as the AI SDK did", async () => {
    const execute = vi.fn(async () => "/workspace");
    const model = new MockLanguageModelV4({
      doStream: async () => textStreamResult("The command returned /workspace."),
      modelId: "generate-approval-resume-model",
      provider: "eve-integration-mock",
    });
    const reported: string[] = [];
    const integration: Telemetry = {
      onStart: () => {
        reported.push("model operation");
      },
      onToolExecutionStart: (event) => {
        reported.push(`start ${event.toolCall.toolCallId}`);
      },
      executeTool: async ({ execute: run, toolCallId }) => {
        reported.push(`execute ${toolCallId}`);
        return await run();
      },
      onToolExecutionEnd: (event) => {
        reported.push(`end ${event.toolCall.toolCallId} ${event.toolOutput.type}`);
      },
    };
    const resultAttempts: Array<number | undefined> = [];
    const instrumentation: NonNullable<ToolLoopHarnessConfig["instrumentation"]> = {
      installAiSdkWarningLogger: () => {},
      runStep: async (input, run) =>
        await run({
          createHandleEvent:
            ({ getAttemptScope }) =>
            async (event) => {
              if (event.type === "action.result")
                resultAttempts.push(getAttemptScope?.()?.attemptIndex);
            },
          prepareAttempt: ({ attemptIndex, stepIndex, turnId }) => ({
            complete: async () => {},
            fail: async () => {},
            scope: {
              attemptId: `${turnId}:${stepIndex}:${attemptIndex}`,
              attemptIndex,
              sessionId: input.session.sessionId,
              stepIndex,
              turnId,
            } as InstrumentationAttemptScope,
            telemetry: { integrations: [integration], isEnabled: true },
          }),
          preparePreamble: async () => undefined,
          publishInputResolutions: async () => {},
          recordError: () => {},
          resolveRuntimeContext: () => undefined,
          session: input.session,
          setTurnId: () => {},
          telemetry: () => undefined,
        }),
    };

    await contextStorage.run(createApprovalContext(), () =>
      createToolLoopHarness({ ...createConfig(model, execute), instrumentation })(
        createPendingApprovalSession(),
        { inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }] },
      ),
    );

    expect(execute).toHaveBeenCalledOnce();
    // The AI SDK ran the call inside its model operation; it now runs just before, in the same
    // attempt.
    expect(reported).toEqual([
      `start ${toolCall.toolCallId}`,
      `execute ${toolCall.toolCallId}`,
      `end ${toolCall.toolCallId} tool-result`,
      "model operation",
    ]);
    expect(resultAttempts).toEqual([0]);
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

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      // The notice the park committed.
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toBeUndefined();
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

  // Regression: turn-local context (a dynamic skill announcement) was
  // appended as a user message after the approval response. The AI SDK reads
  // approvals only from the tail tool message, so the approved tool never ran
  // and the provider rejected the prompt with a tool call that had no output.
  it.each([false, true])(
    "executes the approved tool when a dynamic skill announcement is injected on the resume step (restored anchor: %s)",
    async (restoredAnchor) => {
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
      // The parked shape when a gated call shares a step with an ungated one.
      const session = withParkedStep(createBaseSession(), {
        messages: [
          { content: [toolCall, approvalRequest, siblingCall], role: "assistant" },
          { content: [siblingResult], role: "tool" },
        ],
        requests: [pendingApprovalInputRequest],
      });
      const ctx = new ContextContainer();
      const runtimeContextAnnouncement = "Available skills\n- policy: Tenant policy";
      ctx.set(PendingSkillAnnouncementKey, runtimeContextAnnouncement);
      const execute = vi.fn(async () => "/workspace");
      const model = createModel();
      const runStep = createToolLoopHarness(createConfig(model, execute));

      const result = await contextStorage.run(ctx, () =>
        runStep(
          withOpenTurn(
            restoredAnchor
              ? setTurnClientContextState(session, {
                  insertionIndex: 0,
                  messages: [],
                  turnId: "turn-1",
                })
              : session,
            { sequence: 1, stepIndex: 1, turnId: "turn-1" },
          ),
          { inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }] },
        ),
      );

      expect(execute).toHaveBeenCalledExactlyOnceWith(
        toolCall.input,
        expect.objectContaining({ toolCallId: toolCall.toolCallId }),
      );

      const providerPrompt = model.doStreamCalls[0]?.prompt ?? [];
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
      expect(JSON.stringify(providerPrompt)).toContain("Tenant policy");
      expect(ctx.get(HistoryStateKey)).toMatchObject({
        availableSkills: runtimeContextAnnouncement,
      });
      expect(result.session.history.at(-1)).toMatchObject({
        content: [{ text: "The command returned /workspace.", type: "text" }],
        role: "assistant",
      });

      const continued = await contextStorage.run(ctx, () =>
        runStep(result.session, { message: "Continue." }),
      );
      expect(
        continued.session.history.filter(
          (message) => message.content === runtimeContextAnnouncement,
        ),
      ).toHaveLength(1);
      expect(ctx.get(HistoryStateKey)).toMatchObject({
        availableSkills: runtimeContextAnnouncement,
      });
    },
  );

  // Acceptance gate for the HITL non-blocking plan (research/hitl-request-lifecycle.md):
  // once messages run as normal turns while an approval is open, the approval batch is
  // restored *after* that intervening exchange. This proves the AI SDK accepts the
  // late-spliced transcript shape before any behavior change lands.
  it("splices the approved batch after an intervening conversation turn", async () => {
    const interveningHistory: readonly HarnessModelMessage[] = [
      { content: "Run pwd.", kind: "user", role: "user" },
      { content: "Any update on that command?", kind: "user", role: "user" },
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

    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    // The provider prompt keeps the intervening turn before the restored batch.
    const providerPrompt = model.doStreamCalls[0]?.prompt ?? [];
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

    // Committed history: intervening exchange and the pending-approval notice first, then the
    // restored batch, exactly once.
    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toBeUndefined();
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });
});
