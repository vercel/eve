import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { turnStep } from "#execution/session/turn-step.js";
import { appendPendingInputBatch, hasPendingInputBatch } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessSession } from "#harness/types.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  createExecutionNodeStep: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#execution/node-step.js", () => ({
  buildRuntimeIdentity: () => ({ agentId: "repro-agent", eveVersion: "0.0.0-repro" }),
  createExecutionNodeStep: mocks.createExecutionNodeStep,
}));

vi.mock("#runtime/cache-key.js", () => ({
  resolveRuntimeCompiledArtifactsVersionedCacheKey: vi.fn().mockResolvedValue("repro-cache-key"),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "repro-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "repro-continuation",
    history: [],
    sessionId: "repro-session",
  };
}

const adapter: ChannelAdapter = { kind: "repro" };
const turnAgent = {
  id: "repro-agent",
  instructions: ["You are a test assistant."],
  model: { id: "repro-model" },
  skills: [],
  tools: [],
  workspaceSpec: {},
};

function createBundle() {
  return {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: {},
    graph: {
      nodesByNodeId: new Map(),
      root: { sandboxRegistry: { sandbox: null }, turnAgent },
    },
    hookRegistry: createEmptyHookRegistry(),
    moduleMap: { nodes: {} },
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent,
  } as never;
}

function createSerializedContext(bundle: ReturnType<typeof createBundle>): Record<string, unknown> {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "repro-continuation");
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, "repro-session");
  return serializeContext(ctx);
}

function createWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({ write: () => undefined });
}

describe("issue #3414", () => {
  it("cancelled denial restores stale pending approval", async () => {
    const controller = new AbortController();
    const events: UnstampedMessageStreamEvent[] = [];
    let sawRejectedAction = false;
    let modelCallStarted = false;

    const model = new MockLanguageModelV3({
      modelId: "repro-model",
      provider: "eve-repro",
      doStream: async () => ({
        stream: new ReadableStream({
          start(streamController) {
            modelCallStarted = true;
            streamController.enqueue({ type: "stream-start", warnings: [] });
            streamController.enqueue({ id: "response", type: "text-start" });
            streamController.enqueue({
              delta: "This response will be interrupted.",
              id: "response",
              type: "text-delta",
            });
            controller.abort(new TurnCancelledError());
          },
        }),
      }),
    });

    mocks.createExecutionNodeStep.mockImplementation(
      (input: {
        readonly abortSignal?: AbortSignal;
        readonly handleEvent?: (
          event: UnstampedMessageStreamEvent,
          messages?: readonly import("ai").ModelMessage[],
        ) => Promise<void>;
        readonly mode: "conversation" | "task";
      }) =>
        createToolLoopHarness({
          abortSignal: input.abortSignal,
          handleEvent: async (event, messages) => {
            events.push(event);
            await input.handleEvent?.(event, messages);
            if (
              event.type === "action.result" &&
              event.data.status === "rejected" &&
              (event.data.result as { readonly output?: { readonly code?: string } }).output
                ?.code === "TOOL_EXECUTION_DENIED"
            ) {
              sawRejectedAction = true;
            }
          },
          mode: input.mode,
          resolveModel: vi.fn().mockResolvedValue(model),
          tools: new Map(),
        }),
    );

    const session = appendPendingInputBatch({
      event: { sequence: 2, stepIndex: 1, turnId: "turn_2" },
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
        },
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
        },
      ],
      session: createSession(),
    });
    const bundle = createBundle();
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue(bundle);

    const result = await turnStep({
      abortSignal: controller.signal,
      input: {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "cancel", requestId: "approval-1" }] }],
        },
      },
      sessionWritable: createWritable(),
      serializedContext: createSerializedContext(bundle),
      sessionState: createDurableSessionState({ session }),
    });

    const stalePendingApprovalAfterCancellation = hasPendingInputBatch(
      result.sessionState.snapshot?.session.state,
    );
    console.info(
      JSON.stringify({
        actionResultRecordedBeforeInterrupt: sawRejectedAction,
        modelCallStarted,
        resultAction: result.action,
        stalePendingApprovalAfterCancellation,
      }),
    );

    expect(result.action).toBe("cancelled");
    expect(sawRejectedAction).toBe(true);
    expect(modelCallStarted).toBe(true);
    expect(stalePendingApprovalAfterCancellation).toBe(false);
  });
});
