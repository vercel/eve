import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ConversationIdKey,
  InitiatorAuthKey,
  ParentSessionKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
  TraceRootKey,
} from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  createInstrumentationHooks,
  inputIdempotencyKey,
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  toolCallIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationAttemptScope,
} from "#instrumentation/lifecycle.js";
import { bindInstrumentationRuntime } from "#instrumentation/runtime.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { AGENT_TRACE_CONTEXT_KEY } from "#tracing/agent-trace-context-codec.js";
import { resolveToolCallAgentTrace } from "#tracing/agent-invocation-coordinator.js";
import * as instrumentation from "#instrumentation/runtime.js";
import {
  assembleLocalTrace,
  isAgentTurnSpan,
  parseLocalTraceSegment,
  type LocalTraceSpan,
} from "#tracing/local-trace-reader.js";
import { summarizeLocalTrace } from "#tracing/local-trace-summary.js";
import { buildConversationItems } from "#cli/dev/tui/traces/trace-conversation.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { resolveConnectionTools } from "#execution/tools/connection-tools.js";
import { emitNestedToolActions } from "#harness/nested-actions.js";
import { createInstrumentationHandleEvent } from "#instrumentation/native-events.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import { taskWaitTool } from "#tools/provided/task-wait.js";
import { taskCancelTool } from "#tools/provided/task-cancel.js";
import { jsonSchema } from "ai";

const traceContext = (agentName: string, audience: "public" | "private") => ({
  agentName,
  audience,
  channel: { kind: "http" as const },
  environment: "production" as const,
  principalType: "anonymous",
});

function createRuntime() {
  const exporter = new InMemorySpanExporter();
  const metadata = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
      contentFilteringProcessor(new SimpleSpanProcessor(metadata), {
        span: () => ({ redact: true, inputs: true, outputs: true }),
      }),
    ],
  });
  const agent = createAgentOtelInstrumentation({
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: provider.getTracer("eve.agent"),
  });
  const hooks = createInstrumentationHooks([agent.hook]);
  return {
    ...agent,
    hooks,
    exporter,
    metadata,
    provider,
    idGenerator,
    ownsAgentSpans: true,
    otelSettings: { recordInputs: true, recordOutputs: true, traceChannelRequests: false },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

function contextFor(audience: "public" | "private") {
  const ctx = new ContextContainer();
  ctx.set(ChannelInstrumentationKey, { kind: "http", metadata: {} });
  ctx.set(ConversationContextKey, traceContext("parent", audience));
  ctx.set(AuthKey, {
    principalId: "current-user",
    principalType: "service",
    authenticator: "api-key",
    attributes: { secret: "auth-only-secret" },
  });
  ctx.set(InitiatorAuthKey, {
    principalId: "initiator-user",
    principalType: "user",
    authenticator: "oidc",
    attributes: { secret: "auth-only-secret" },
  });
  return ctx;
}

function scopeFor(sessionId: string, audience: "public" | "private"): InstrumentationAttemptScope {
  return {
    attemptId: `${sessionId}:turn_0:0:0`,
    attemptIndex: 0,
    channelAudience: audience,
    functionId: sessionId,
    sessionId,
    rootSessionId: "parent",
    stepIndex: 0,
    turnId: "turn_0",
  };
}

describe("exported agent telemetry contract", () => {
  it.each(["public", "private"] as const)(
    "parents nested connector actions and preserves resolved arguments under the %s content policy",
    async (audience) => {
      const runtime = createRuntime();
      const ctx = contextFor(audience);
      const scope = scopeFor("parent", audience);
      const hooks = runtime.hooks.forTrace!(traceContext("parent", audience));
      const executeTool = vi.fn(async () => ({ structuredContent: { title: "Issue" } }));
      ctx.set(ConnectionRegistryKey, {
        dispose: async () => {},
        getConnectionApproval: () => undefined,
        getConnectionNames: () => ["linear"],
        getConnections: () => [
          {
            connectionName: "linear",
            protocol: "mcp",
            url: "https://linear.example.com/mcp",
            description: "Issues",
            sourceId: "linear",
            sourceKind: "module",
            logicalPath: "connections/linear",
          },
        ],
        getClient: () => ({
          close: async () => {},
          connect: async () => {},
          executeTool,
          getToolMetadata: async () => [
            {
              name: "get_issue",
              description: "Read an issue",
              inputSchema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  includeRelations: { type: "boolean", default: false },
                },
                required: ["id"],
              },
            },
          ],
        }),
      });
      const accepted = vi.fn(async () => {});
      const handleEvent = createInstrumentationHandleEvent({
        getAttemptScope: () => scope,
        handleEvent: accepted,
        hooks,
        sessionId: "parent",
      })!;
      const input = { connection: "linear", tool: "get_issue", input: { id: "ISSUE-1" } };
      const toolKey = toolCallIdempotencyKey(scope, "call-1", 0);
      try {
        await contextStorage.run(ctx, async () => {
          await bindInstrumentationRuntime(runtime, ctx, {
            agentName: "parent",
            rootSessionId: "parent",
            sessionId: "parent",
          })!.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
          await hooks.publish({
            type: "step.attempt.started",
            idempotencyKey: attemptIdempotencyKey(scope),
            scope,
            operation: { modelId: "test", operationId: "ai.streamText", provider: "test" },
          });
          await handleEvent(
            createActionsRequestedEvent({
              actions: [
                { callId: "call-1", kind: "tool-call", toolName: "connection_execute", input },
              ],
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
          await hooks.observeToolExecution!({
            type: "tool.call.started",
            idempotencyKey: toolKey,
            callId: "call-1",
            input,
            toolName: "connection_execute",
            scope,
          });
          const output = await runtime.runInContext(
            { idempotencyKey: toolKey, scope, type: "tool.call" },
            () =>
              resolveConnectionTools()!.connection_execute!.execute!(input, {
                callId: "call-1",
                messages: [],
              } as never),
          );
          await hooks.observeToolExecution!({
            type: "tool.call.completed",
            idempotencyKey: toolKey,
            output: { type: "result", output },
            scope,
          });
          await emitNestedToolActions(
            handleEvent,
            { sequence: 0, stepIndex: 0, turnId: "turn_0" },
            "call-1",
          );
          await handleEvent(
            createActionResultEvent({
              result: {
                callId: "call-1",
                kind: "tool-result",
                toolName: "connection_execute",
                output: output as JsonValue,
              },
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
          await hooks.publish({
            type: "step.attempt.completed",
            idempotencyKey: attemptIdempotencyKey(scope),
            scope,
          });
        });
        await runtime.forceFlush();
        expect(executeTool.mock.calls[0]).toEqual([
          "get_issue",
          { id: "ISSUE-1", includeRelations: false },
          { abortSignal: undefined, callId: "call-1" },
        ]);
        expect(accepted.mock.calls).toHaveLength(4);
        const actions = runtime.exporter
          .getFinishedSpans()
          .filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
        expect(actions).toHaveLength(2);
        const outer = actions.find((span) => span.attributes["agent.action.call_id"] === "call-1")!;
        const nested = actions.find(
          (span) => span.attributes["agent.action.call_id"] === "call-1:1",
        )!;
        expect(outer.attributes["agent.action.kind"]).toBe("tool-call");
        expect(nested.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
        expect(nested.attributes).toMatchObject({
          "agent.action.kind": "tool-call",
          "agent.action.parent_call_id": "call-1",
          "agent.action.name": "linear__get_issue",
        });
        const tool = runtime.exporter
          .getFinishedSpans()
          .find((span) => span.name === "execute_tool connection_execute")!;
        expect(tool.spanContext().spanId).toBe(outer.spanContext().spanId);
        expect(nested.attributes["gen_ai.tool.call.arguments"]).toBe(
          audience === "public" ? '{"id":"ISSUE-1","includeRelations":false}' : undefined,
        );
        expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe(
          audience === "public" ? JSON.stringify(input) : undefined,
        );
        const metadataNested = runtime.metadata
          .getFinishedSpans()
          .find((span) => span.attributes["agent.action.call_id"] === "call-1:1")!;
        expect(metadataNested.attributes).not.toHaveProperty("gen_ai.tool.call.arguments");
      } finally {
        await runtime.shutdown();
      }
    },
  );
  it.each([
    {
      tool: taskWaitTool,
      input: { timeoutSeconds: 30 },
      duration: 25_000,
      replacement: true,
      failed: false,
    },
    {
      tool: taskWaitTool,
      input: { timeoutSeconds: 0 },
      duration: 0,
      replacement: false,
      failed: false,
    },
    {
      tool: taskCancelTool,
      input: { taskId: "research" },
      duration: 0,
      replacement: false,
      failed: false,
    },
    { tool: taskWaitTool, input: {}, duration: 10_000, replacement: true, failed: true },
  ])(
    "exports $tool.name with its original duration (replacement=$replacement, failed=$failed)",
    async ({ tool, input, duration, replacement, failed }) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      const first = createRuntime();
      let runtime = first;
      let ctx = contextFor("public");
      const scope = scopeFor("parent", "public");
      const startedAtMs = Date.now();
      const completedAtMs = startedAtMs + duration;
      try {
        await contextStorage.run(ctx, async () => {
          const binding = bindInstrumentationRuntime(first, ctx, {
            agentName: "parent",
            rootSessionId: "parent",
            sessionId: "parent",
          })!;
          await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
          const emit = createInstrumentationHandleEvent({
            sessionId: "parent",
            hooks: first.hooks.forTrace!(traceContext("parent", "public")),
            handleEvent: async () => {},
            getAttemptScope: () => scope,
          })!;
          const action = createPresentedRuntimeActionRequestFromToolCall({
            toolCall: { type: "tool-call", input, toolCallId: "control", toolName: tool.name },
            tools: new Map([[tool.name, tool]]),
          }).action;
          await emit(
            createActionsRequestedEvent({
              actions: [action],
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
        });
        if (replacement) {
          ctx = await deserializeContext(serializeContext(ctx));
          runtime = createRuntime();
        }
        await contextStorage.run(ctx, async () => {
          const binding = bindInstrumentationRuntime(runtime, ctx, {
            agentName: "parent",
            rootSessionId: "parent",
            sessionId: "parent",
          })!;
          await binding.instrumentTaskToolCall({
            callId: "control",
            toolName: tool.name as "task_wait" | "task_cancel",
            startedAtMs,
            completedAtMs,
            input,
            output: "Alice's research finished.",
            failed,
          });
          const emit = createInstrumentationHandleEvent({
            sessionId: "parent",
            hooks: runtime.hooks.forTrace!(traceContext("parent", "public")),
            handleEvent: async () => {},
          })!;
          await emit(
            createActionResultEvent({
              result: {
                callId: "control",
                kind: "tool-result",
                toolName: tool.name,
                output: "Alice's research finished.",
              },
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
        });
        const spans = runtime.exporter.getFinishedSpans();
        const action = spans.find((span) => span.name === `execute_tool ${tool.name}`)!;
        const execution = spans.find((span) => span.name === `execute_tool ${tool.name}`)!;
        expect(execution).toBeDefined();
        expect(spans.filter((span) => span.name === execution.name)).toHaveLength(1);
        expect(execution.attributes["agent.tool.is_framework"]).toBe(true);
        expect(action.attributes).not.toHaveProperty("agent.action.origin");
        expect(action.attributes).not.toHaveProperty("agent.framework.action");
        expect(execution.startTime).toEqual([
          Math.floor(startedAtMs / 1_000),
          (startedAtMs % 1_000) * 1_000_000,
        ]);
        expect(execution.duration).toEqual([
          Math.floor(duration / 1_000),
          (duration % 1_000) * 1_000_000,
        ]);
        expect(execution.status.code).toBe(failed ? 2 : 0);
        expect(
          runtime.metadata.getFinishedSpans().find((span) => span.name === execution.name)
            ?.attributes,
        ).toMatchObject({
          "agent.tool.is_framework": true,
        });
      } finally {
        vi.unstubAllEnvs();
        await first.shutdown();
        if (runtime !== first) await runtime.shutdown();
      }
    },
  );

  it.each(["subagent-call", "remote-agent-call"] as const)(
    "exports deferred %s as a caller with a tool child after worker replacement",
    async (kind) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      const first = createRuntime();
      const second = createRuntime();
      const ctx = contextFor("public");
      const scope = scopeFor("parent", "public");
      try {
        await contextStorage.run(ctx, async () => {
          await bindInstrumentationRuntime(first, ctx, {
            agentName: "parent",
            rootSessionId: "parent",
            sessionId: "parent",
          })!.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
          const action = createPresentedRuntimeActionRequestFromToolCall({
            toolCall: {
              type: "tool-call",
              input: { message: "Review Alice's draft." },
              toolCallId: "review",
              toolName: "reviewer",
            },
            tools: new Map([
              [
                "reviewer",
                {
                  name: "reviewer",
                  frameworkTool: true,
                  description: "Review drafts.",
                  inputSchema: jsonSchema({ type: "object" }),
                  workflowId: "review-workflow",
                  behavior: {
                    availability: [],
                    handling: {
                      kind: "dispatch",
                      target:
                        kind === "subagent-call"
                          ? { kind, nodeId: "reviewer-node", subagentName: "reviewer" }
                          : { kind, nodeId: "reviewer-node", remoteAgentName: "reviewer" },
                    },
                  },
                },
              ],
            ]),
          }).action;
          await createInstrumentationHandleEvent({
            sessionId: "parent",
            hooks: first.hooks.forTrace!(traceContext("parent", "public")),
            handleEvent: async () => {},
            getAttemptScope: () => scope,
            isFrameworkTool: () => true,
          })!(
            createActionsRequestedEvent({
              actions: [action],
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
        });
        const restored = await deserializeContext(serializeContext(ctx));
        await contextStorage.run(restored, async () => {
          await createInstrumentationHandleEvent({
            sessionId: "parent",
            hooks: second.hooks.forTrace!(traceContext("parent", "public")),
            handleEvent: async () => {},
          })!(
            createActionResultEvent({
              result: {
                callId: "review",
                kind: "tool-result",
                toolName: "reviewer",
                output: "Looks ready.",
              },
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            }),
          );
        });
        const spans = second.exporter.getFinishedSpans();
        const action = spans.find((span) => span.name === "execute_tool reviewer")!;
        expect(action.attributes).toMatchObject({
          "agent.action.kind": kind,
          "agent.invocation.role": "caller",
          "gen_ai.agent.name": "reviewer",
        });
        expect(spans.filter((span) => span.name === "execute_tool reviewer")).toHaveLength(1);
        expect(
          spans.find((span) => span.name === "execute_tool reviewer")?.attributes[
            "agent.tool.is_framework"
          ],
        ).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        await first.shutdown();
        await second.shutdown();
      }
    },
  );
  it("preserves explicit trace-session identity on every remote and local-child span", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const runtime = { ...createRuntime(), memoryOperations: true };
    try {
      for (const sessionId of ["remote", "local-child"]) {
        const ctx = contextFor("public");
        ctx.set(ConversationIdKey, "caller-conversation");
        ctx.set(
          TraceRootKey,
          sessionId === "remote" ? { kind: "own" } : { kind: "inherited", sessionId: "remote" },
        );
        ctx.set(ParentSessionKey, {
          callId: "dispatch",
          rootSessionId: "caller-root",
          sessionId: sessionId === "remote" ? "caller" : "remote",
          turn: { id: "turn_0", sequence: 0 },
        });
        const bound = bindInstrumentationRuntime(runtime, ctx, {
          agentName: sessionId,
          rootSessionId: "caller-root",
          sessionId,
        })!;
        const hooks = runtime.hooks.forTrace!(traceContext(sessionId, "public"));
        await contextStorage.run(ctx, async () => {
          await bound.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
          await bound.prepareExecution().runStep(
            {
              environment: "production",
              eveVersion: "test",
              hasInput: true,
              session: { sessionId },
            },
            async (step) => {
              const attempt = step.prepareAttempt({
                attemptIndex: 0,
                stepIndex: 0,
                turnId: "turn_0",
              });
              const scope = attempt.scope;
              await hooks.publish({
                type: "step.attempt.started",
                idempotencyKey: attemptIdempotencyKey(scope),
                scope,
                operation: { modelId: "test", operationId: "ai.streamText", provider: "test" },
              });
              const actionKey = actionIdempotencyKey(sessionId, "turn_0", "tool");
              const toolKey = toolCallIdempotencyKey(scope, "tool", 0);
              const modelKey = modelCallIdempotencyKey(scope, 0, 0);
              await hooks.publish({
                type: "tool.call.started",
                idempotencyKey: actionKey,
                scope,
                callId: "tool",
                toolName: "inspect",
                kind: "tool-call",
                input: {},
              });
              await hooks.observeToolExecution!({
                type: "tool.call.started",
                idempotencyKey: toolKey,
                scope,
                callId: "tool",
                toolName: "inspect",
                input: {},
              });
              await hooks.publish({
                type: "model.call.started",
                idempotencyKey: modelKey,
                scope,
                model: { modelId: "test", provider: "test" },
              });
              await hooks.publish({
                type: "model.call.completed",
                idempotencyKey: modelKey,
                scope,
                finishReason: "stop",
                content: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              });
              const approvalKey = inputIdempotencyKey(sessionId, "turn_0", "approval");
              await hooks.publish({
                type: "input.requested",
                idempotencyKey: approvalKey,
                scope,
                requestId: "approval",
                kind: "tool-approval",
                action: { callId: "tool", name: "inspect" },
                request: { prompt: "Approve" },
              });
              // State must preserve identity when execution resumes with a different context.
              const saved = serializeContext(ctx);
              const restored = await deserializeContext(saved);
              await contextStorage.run(restored, async () => {
                await hooks.publish({
                  type: "input.resolved",
                  idempotencyKey: approvalKey,
                  scope,
                  requestId: "approval",
                  kind: "tool-approval",
                  outcome: "approved",
                  response: {},
                });
                await hooks.observeToolExecution!({
                  type: "tool.call.completed",
                  idempotencyKey: toolKey,
                  scope,
                  output: { type: "result", output: {} },
                });
                await hooks.publish({
                  type: "tool.call.completed",
                  idempotencyKey: actionKey,
                  scope,
                  outcome: "completed",
                  output: { type: "result", output: {} },
                });
              });
              await bound.memory!.execute(
                {
                  idempotencyKey: `memory:${sessionId}`,
                  operationName: "search_memory",
                  phase: "turn.started",
                  slot: "notes",
                  storeId: "store",
                  turnId: "turn_0",
                },
                async () => ({ value: undefined }),
              );
              await attempt.complete();
            },
          );
          await hooks.publish({
            type: "turn.completed",
            idempotencyKey: turnIdempotencyKey(sessionId, "turn_0"),
            sessionId,
            turnId: "turn_0",
          });
          await hooks.publish({
            type: "session.waiting",
            idempotencyKey: sessionIdempotencyKey(sessionId),
            sessionId,
            turnId: "turn_0",
          });
        });
      }
      await runtime.forceFlush();
      const owned = runtime.exporter
        .getFinishedSpans()
        .filter((span) => typeof span.attributes["agent.run.id"] === "string");
      for (const runId of ["remote", "local-child"]) {
        const spans = owned.filter((span) => span.attributes["agent.run.id"] === runId);
        expect(spans.map((span) => span.name).sort()).toEqual(
          [
            `invoke_agent ${runId}`,
            "agent.step",
            "chat test",
            "execute_tool inspect",
            "agent.approval",
            "search_memory",
          ].sort(),
        );
        for (const span of spans) {
          expect(span.attributes["vercel.session_id"]).toBe("remote");
          expect(span.attributes["gen_ai.conversation.id"]).toBe("caller-conversation");
        }
      }
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
    }
  });

  it("exports remote roots and a nested local child with the remote project's session grouping", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const runtime = createRuntime();
    const caller = {
      isRemote: true,
      spanId: "a".repeat(16),
      traceFlags: 1,
      traceId: "b".repeat(32),
    };
    const hooks = runtime.hooks.forTrace!(traceContext("remote", "public"));
    const remote = contextFor("public");
    remote.set(ConversationIdKey, "caller-root");
    remote.set(TraceRootKey, { kind: "own" });
    remote.set(ParentSessionKey, {
      callId: "remote-call",
      rootSessionId: "caller-root",
      sessionId: "caller-root",
      turn: { id: "turn_0", sequence: 0 },
    });
    remote.set(ParentTraceContextKey, caller);
    try {
      for (const sequence of [0, 1]) {
        const turnId = `turn_${sequence}`;
        await contextStorage.run(remote, async () => {
          const binding = bindInstrumentationRuntime(runtime, remote, {
            agentName: "remote",
            rootSessionId: "caller-root",
            sessionId: "remote-session",
          })!;
          await binding.preparePreamble({ sequence, sessionStarted: sequence > 0, turnId });
          await hooks.publish({
            idempotencyKey: turnIdempotencyKey("remote-session", turnId),
            sessionId: "remote-session",
            turnId,
            type: "turn.completed",
          });
          await hooks.publish({
            idempotencyKey: sessionIdempotencyKey("remote-session"),
            sessionId: "remote-session",
            turnId,
            type: "session.waiting",
          });
        });
      }
      const remoteSpan = runtime.exporter.getFinishedSpans()[0]!;
      const child = contextFor("public");
      child.set(ConversationIdKey, "caller-root");
      child.set(TraceRootKey, { kind: "inherited", sessionId: "remote-session" });
      child.set(ParentSessionKey, {
        callId: "local-call",
        rootSessionId: "caller-root",
        sessionId: "remote-session",
        turn: { id: "turn_0", sequence: 0 },
      });
      child.set(ParentTraceContextKey, remoteSpan.spanContext());
      await contextStorage.run(child, async () => {
        const binding = bindInstrumentationRuntime(runtime, child, {
          agentName: "local",
          rootSessionId: "caller-root",
          sessionId: "local-session",
        })!;
        await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
        await hooks.publish({
          idempotencyKey: sessionIdempotencyKey("local-session"),
          sessionId: "local-session",
          turnId: "turn_0",
          type: "session.waiting",
        });
      });
      await runtime.forceFlush();
      const exported = runtime.exporter.getFinishedSpans();
      const serialized = new TextDecoder().decode(JsonTraceSerializer.serializeRequest(exported)!);
      const traceIds = [...new Set(exported.map((span) => span.spanContext().traceId))];
      expect(traceIds).toHaveLength(2);
      const parsed = traceIds.flatMap((traceId) => parseLocalTraceSegment(serialized, traceId));
      expect(parsed).toHaveLength(3);
      expect(new Set(parsed.map((span) => span.spanId)).size).toBe(3);
      for (const span of parsed) {
        expect(span.attributes["gen_ai.conversation.id"]).toBe("caller-root");
        expect(span.attributes["vercel.session_id"]).toBe("remote-session");
      }
      const remoteTurns = parsed.filter(
        (span) => span.attributes["agent.run.id"] === "remote-session",
      );
      expect(remoteTurns).toHaveLength(2);
      expect(remoteTurns[0]!.parentSpanId).toBeUndefined();
      expect(remoteTurns[0]!.traceId).not.toBe(caller.traceId);
      expect(remoteSpan.links).toEqual([
        { context: caller, attributes: { "eve.link.type": "agent.dispatch" } },
      ]);
      expect(remoteTurns[1]!.parentSpanId).toBeUndefined();
      expect(remoteTurns[1]!.traceId).not.toBe(caller.traceId);
      const local = parsed.find((span) => span.attributes["agent.run.id"] === "local-session")!;
      expect(local.parentSpanId).toBe(remoteSpan.spanContext().spanId);
      expect(local.attributes["agent.parent_run.id"]).toBe("remote-session");
      // Downstream readers use this export; normalize host metadata and clock values for CI.
      const fixture = JSON.parse(serialized) as unknown;
      const normalizeTimes = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const child of value) normalizeTimes(child);
          return;
        }
        if (value === null || typeof value !== "object") return;
        if (Reflect.get(value, "key") === "service.name") {
          Reflect.set(value, "value", { stringValue: "eve-trace-contract" });
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === "startTimeUnixNano" || key === "timeUnixNano")
            Reflect.set(value, key, "1700000000000000000");
          else if (key === "endTimeUnixNano") Reflect.set(value, key, "1700000000001000000");
          else normalizeTimes(child);
        }
      };
      normalizeTimes(fixture);
      await expect(`${JSON.stringify(fixture, null, 2)}\n`).toMatchFileSnapshot(
        "./test-data/remote-local-agent-trace.otlp.json",
      );
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
    }
  });

  it.each(["public", "private"] as const)(
    "round-trips the normalized %s v4 trace forest through OTLP",
    async (audience) => {
      const runtime = createRuntime();
      let parent = contextFor(audience);
      parent.set(ConversationIdKey, "original-conversation");
      const scope = scopeFor("parent", audience);
      const hooks = runtime.hooks.forTrace!(traceContext("parent", audience));
      const actionKey = actionIdempotencyKey("parent", "turn_0", "workflow");
      const operation = { modelId: "test", operationId: "ai.streamText", provider: "test" };
      const binding = bindInstrumentationRuntime(runtime, parent, {
        agentName: "parent",
        rootSessionId: "parent",
        sessionId: "parent",
      })!;
      let dispatch: ReturnType<typeof resolveToolCallAgentTrace>;
      await contextStorage.run(parent, async () => {
        await binding.preparePreamble({ sequence: 0, sessionStarted: false });
        await binding.instrumentChannelDelivery({
          ctx: parent,
          agentName: "parent",
          rootSessionId: "parent",
          sequence: 0,
          sessionId: "parent",
          turnId: "turn_0",
          delivery: {
            kind: "deliver",
            payloads: [{ message: "private input" }],
            deliveryMetadata: [
              {
                channelKind: "http",
                channelName: "web",
                deliveryId: "delivery",
                payloadIndex: 0,
                requestTraceContext: {
                  spanId: "e".repeat(16),
                  traceFlags: 1,
                  traceId: "f".repeat(32),
                },
              },
            ],
          },
        });
        // The tool loop prepares turn trace state after the delivery is instrumented.
        await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
        await hooks.publish({
          idempotencyKey: attemptIdempotencyKey(scope),
          operation,
          scope,
          type: "step.attempt.started",
        });
        await hooks.publish({
          callId: "workflow",
          idempotencyKey: actionKey,
          input: { secret: "private input" },
          isWorkflowTool: true,
          kind: "tool-call",
          toolName: "coordinate",
          scope,
          type: "tool.call.started",
        });
        await hooks.observeToolExecution!({
          callId: "workflow",
          idempotencyKey: toolCallIdempotencyKey(scope, "workflow", 0),
          input: { secret: "private input" },
          toolName: "coordinate",
          scope,
          type: "tool.call.started",
        });
        const approvalKey = inputIdempotencyKey("parent", "turn_0", "approval");
        await hooks.publish({
          action: { callId: "workflow", name: "coordinate" },
          idempotencyKey: approvalKey,
          kind: "tool-approval",
          requestId: "approval",
          scope,
          type: "input.requested",
          request: { prompt: "private approval" },
        });
        await hooks.publish({
          idempotencyKey: approvalKey,
          kind: "tool-approval",
          outcome: "approved",
          requestId: "approval",
          response: { text: "private approval answer" },
          scope,
          type: "input.resolved",
        });
        dispatch = resolveToolCallAgentTrace({
          callId: "workflow",
          conversation: parent.get(ConversationContextKey),
          serializedContext: serializeContext(parent),
          sessionId: "parent",
          turnId: "turn_0",
        });
      });
      const child = contextFor(audience);
      child.set(ConversationIdKey, dispatch!.conversationId!);
      child.set(ParentSessionKey, {
        callId: "workflow",
        rootSessionId: "parent",
        sessionId: "parent",
        turn: { id: "turn_0", sequence: 0 },
      });
      if (dispatch!.parentTraceContext !== undefined) {
        child.set(ParentTraceContextKey, dispatch!.parentTraceContext);
        child.set(SessionTraceSeedKey, {
          ...dispatch!.parentTraceContext,
          spanId: runtime.idGenerator.allocateSpanId(),
          traceId: dispatch!.parentTraceContext.traceId,
        });
      }
      const childScope = scopeFor("child", audience);
      const childHooks = runtime.hooks.forTrace!(traceContext("child", audience));
      await contextStorage.run(child, async () => {
        const childBinding = bindInstrumentationRuntime(runtime, child, {
          agentName: "child",
          rootSessionId: "parent",
          sessionId: "child",
        })!;
        await childBinding.preparePreamble({
          sequence: 0,
          sessionStarted: false,
          turnId: "turn_0",
        });
        await childHooks.publish({
          idempotencyKey: attemptIdempotencyKey(childScope),
          operation,
          scope: childScope,
          type: "step.attempt.started",
        });
        const modelKey = modelCallIdempotencyKey(childScope, 0, 0);
        await childHooks.publish({
          idempotencyKey: modelKey,
          model: { modelId: "test", provider: "test" },
          scope: childScope,
          type: "model.call.started",
        });
        await childHooks.publish({
          idempotencyKey: modelKey,
          content: [{ type: "text", text: "private reply" }],
          finishReason: "stop",
          scope: childScope,
          type: "model.call.completed",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
          },
        });
        await childHooks.publish({
          idempotencyKey: attemptIdempotencyKey(childScope),
          scope: childScope,
          type: "step.attempt.completed",
        });
        await childHooks.publish({
          idempotencyKey: turnIdempotencyKey("child", "turn_0"),
          sessionId: "child",
          turnId: "turn_0",
          type: "turn.completed",
        });
        await childHooks.publish({
          idempotencyKey: sessionIdempotencyKey("child"),
          sessionId: "child",
          turnId: "turn_0",
          type: "session.waiting",
        });
      });
      await contextStorage.run(parent, async () => {
        await hooks.observeToolExecution!({
          idempotencyKey: toolCallIdempotencyKey(scope, "workflow", 0),
          output: { type: "result", output: "private output" },
          scope,
          type: "tool.call.completed",
        });
        await hooks.publish({
          idempotencyKey: actionKey,
          outcome: "completed",
          output: { type: "result", output: "private output" },
          scope,
          type: "tool.call.completed",
        });
        await hooks.publish({
          idempotencyKey: attemptIdempotencyKey(scope),
          scope,
          type: "step.attempt.completed",
        });
        await binding.instrumentChannelDelivery({
          ctx: parent,
          includeTurn: true,
          outcome: "completed",
        });
        await hooks.publish({
          idempotencyKey: turnIdempotencyKey("parent", "turn_0"),
          sessionId: "parent",
          turnId: "turn_0",
          type: "turn.completed",
        });
        await hooks.publish({
          idempotencyKey: sessionIdempotencyKey("parent"),
          sessionId: "parent",
          turnId: "turn_0",
          type: "session.waiting",
        });
      });
      for (const [sequence, outcome] of [
        [1, "failed"],
        [2, "cancelled"],
      ] as const) {
        const turnId = `turn_${String(sequence)}`;
        await contextStorage.run(parent, async () => {
          await binding.instrumentChannelDelivery({
            ctx: parent,
            agentName: "parent",
            rootSessionId: "parent",
            sequence,
            sessionId: "parent",
            turnId,
            delivery: {
              kind: "deliver",
              payloads: [{ message: outcome }],
              deliveryMetadata: [
                {
                  channelKind: "http",
                  channelName: "web",
                  deliveryId: `delivery-${outcome}`,
                  payloadIndex: 0,
                },
              ],
            },
          });
          await binding.preparePreamble({ sequence, sessionStarted: true, turnId });
          await binding.instrumentChannelDelivery({
            ctx: parent,
            error: outcome === "failed" ? new Error("expected failure") : undefined,
            includeTurn: true,
            outcome,
          });
          await hooks.publish(
            outcome === "failed"
              ? {
                  error: new Error("expected failure"),
                  idempotencyKey: turnIdempotencyKey("parent", turnId),
                  sessionId: "parent",
                  turnId,
                  type: "turn.failed",
                }
              : {
                  idempotencyKey: turnIdempotencyKey("parent", turnId),
                  sessionId: "parent",
                  turnId,
                  type: "turn.cancelled",
                },
          );
          await hooks.publish({
            idempotencyKey: sessionIdempotencyKey("parent"),
            sessionId: "parent",
            turnId,
            type: "session.waiting",
          });
        });
      }
      await runtime.forceFlush();
      const exported = runtime.exporter.getFinishedSpans();
      const bytes = JsonTraceSerializer.serializeRequest(exported)!;
      const traceIds = [...new Set(exported.map((span) => span.spanContext().traceId))];
      expect(traceIds).toHaveLength(3);
      const traces = traceIds.map((traceId) =>
        assembleLocalTrace(
          traceId,
          parseLocalTraceSegment(new TextDecoder().decode(bytes), traceId),
        ),
      );
      const parsed = traceIds.flatMap((traceId) =>
        parseLocalTraceSegment(new TextDecoder().decode(bytes), traceId),
      );
      expect(parsed).toHaveLength(exported.length);
      expect(
        parsed.every(
          (span) => span.attributes["gen_ai.conversation.id"] === "original-conversation",
        ),
      ).toBe(true);
      expect(
        parsed.every((span) => Number(span.attributes["agent.trace.schema.version"]) === 4),
      ).toBe(true);
      for (const span of parsed) {
        expect(span.attributes["resource.name"]).toBe(span.name);
        expect(span.attributes["operation.name"]).toBe(
          span.attributes["gen_ai.operation.name"] ?? span.name,
        );
        for (const legacy of ["agent.root_run.id", "agent.session.id"]) {
          expect(span.attributes).not.toHaveProperty(legacy);
        }
        expect(span.attributes).not.toHaveProperty("vercel.session_id");
      }
      expect(parsed.filter(isAgentTurnSpan)).toHaveLength(4);
      for (const activation of parsed.filter(isAgentTurnSpan)) {
        expect(activation.attributes["agent.principal.current.type"]).toBe("service");
        expect(activation.attributes["agent.principal.initiator.type"]).toBe("user");
        expect(activation.attributes["agent.principal.current.id"]).toBe(
          audience === "public" ? "current-user" : undefined,
        );
        expect(activation.attributes["agent.principal.initiator.id"]).toBe(
          audience === "public" ? "initiator-user" : undefined,
        );
      }
      expect(new TextDecoder().decode(bytes)).not.toContain("auth-only-secret");
      const workflow = parsed.find(
        (span) =>
          span.attributes["gen_ai.operation.name"] === "execute_tool" &&
          span.attributes["agent.action.call_id"] === "workflow",
      )!;
      const activation = parsed.find(
        (span) => span.name === "invoke_agent child" && isAgentTurnSpan(span),
      )!;
      const parentActivation = parsed.find(
        (span) => span.name === "invoke_agent parent" && isAgentTurnSpan(span),
      )!;
      expect(activation.parentSpanId).toBe(workflow.spanId);
      expect(activation.traceId).toBe(workflow.traceId);
      expect(parentActivation.attributes).toMatchObject({
        "agent.channel.delivery.id": "delivery",
        "agent.channel.kind": "http",
        "agent.channel.name": "web",
      });
      expect(activation.attributes).toMatchObject({
        "agent.parent_call.id": "workflow",
        "agent.parent_run.id": "parent",
        "agent.run.id": "child",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "agent.usage.input_tokens": 10,
        "agent.usage.output_tokens": 5,
      });
      expect(normalizeTraceForest(parsed, exported)).toEqual([
        "conversation original-conversation",
        "trace parent:turn_0 outcome=completed channel=http:web delivery=delivery",
        "  invoked from external via channel.request",
        "  invoke_agent parent",
        "    agent.step",
        "      execute_tool coordinate",
        "        agent.approval approved",
        "        invoke_agent child",
        "          agent.step",
        "            chat test",
        "trace parent:turn_1 outcome=failed channel=http:web delivery=delivery-failed",
        "  invoke_agent parent",
        "trace parent:turn_2 outcome=cancelled channel=http:web delivery=delivery-cancelled",
        "  invoke_agent parent",
      ]);
      expect(summarizeLocalTrace(parsed[0]!.traceId, parsed)).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
      });
      const items = traces.flatMap(buildConversationItems);
      expect(items.find((item) => item.kind === "assistant")).toBeDefined();
      const metadata = new TextDecoder().decode(
        JsonTraceSerializer.serializeRequest(runtime.metadata.getFinishedSpans())!,
      );
      const metadataSpans = traceIds.flatMap((traceId) =>
        parseLocalTraceSegment(metadata, traceId),
      );
      expect(metadataSpans.map((span) => [span.name, span.attributes["resource.name"]])).toEqual(
        parsed.map((span) => [span.name, span.name]),
      );
      expect(metadata).not.toContain("private ");
      if (audience === "private") expect(new TextDecoder().decode(bytes)).not.toContain("private ");
      else expect(new TextDecoder().decode(bytes)).toContain("private reply");
      await runtime.shutdown();
    },
  );

  it("exports new current principals but the same initiator on resumed activations", async () => {
    const runtime = createRuntime();
    const ctx = contextFor("public");
    const hooks = runtime.hooks.forTrace!(traceContext("parent", "public"));
    const binding = bindInstrumentationRuntime(runtime, ctx, {
      agentName: "parent",
      rootSessionId: "parent",
      sessionId: "parent",
    })!;
    await contextStorage.run(ctx, async () => {
      for (const [sequence, principalId] of ["first", "second"].entries()) {
        ctx.set(AuthKey, {
          principalId,
          principalType: "user",
          authenticator: "api-key",
          attributes: {},
        });
        const turnId = `turn_${sequence}`;
        await binding.preparePreamble({ sequence, sessionStarted: sequence > 0, turnId });
        await hooks.publish({
          idempotencyKey: turnIdempotencyKey("parent", turnId),
          sessionId: "parent",
          turnId,
          type: "turn.completed",
        });
        await hooks.publish({
          idempotencyKey: sessionIdempotencyKey("parent"),
          sessionId: "parent",
          turnId,
          type: "session.waiting",
        });
      }
    });
    await runtime.forceFlush();
    const spans = runtime.exporter.getFinishedSpans();
    expect(spans.map((span) => span.attributes["agent.principal.current.id"])).toEqual([
      "first",
      "second",
    ]);
    expect(spans.map((span) => span.attributes["agent.principal.initiator.id"])).toEqual([
      "initiator-user",
      "initiator-user",
    ]);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
    for (const span of spans) {
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.attributes).toMatchObject({
        "agent.trace.schema.version": 4,
        "gen_ai.conversation.id": "parent",
        "operation.name": "invoke_agent",
        "resource.name": "invoke_agent parent",
      });
    }
    await runtime.shutdown();
  });

  it.each([
    ["private", false, false],
    ["private", true, true],
    ["public", false, true],
    ["public", true, false],
    ["public", true, true],
  ] as const)(
    "bounds public-channel principal IDs by origin %s and input/output ceiling %s/%s",
    async (originAudience, recordInputs, recordOutputs) => {
      const logs = captureLogRecords();
      const runtime = createRuntime();
      const hooks = runtime.hooks.forTrace!(traceContext("child", "public"));
      const registered = vi
        .spyOn(instrumentation, "getInstrumentationRuntime")
        .mockReturnValue(runtime);
      let ctx = contextFor("public");
      ctx.set(ParentTraceContextKey, {
        forwardedTracePolicy: {
          ceiling: { recordInputs, recordOutputs },
          originAudience,
        },
        spanId: "c".repeat(16),
        traceFlags: 1,
        traceId: "d".repeat(32),
      });
      const includesIds = originAudience === "public" && recordInputs && recordOutputs;
      try {
        instrumentation.initializeSessionInstrumentation({ agentName: "child", ctx });
        expect(logs.records).toContainEqual(
          expect.objectContaining({ level: "info", message: "resolved forwarded trace policy" }),
        );
        expect(ctx.get(SessionTraceSeedKey)?.decision).toEqual({
          action: "record",
          recordInputs: originAudience === "public" && recordInputs,
          recordOutputs: originAudience === "public" && recordOutputs,
        });
        for (let sequence = 0; sequence < 2; sequence++) {
          const turnId = `turn_${sequence}`;
          await contextStorage.run(ctx, async () => {
            await bindInstrumentationRuntime(runtime, ctx, {
              agentName: "child",
              rootSessionId: "child",
              sessionId: "child",
            })!.preparePreamble({ sequence, sessionStarted: sequence > 0, turnId });
          });
          const serialized = serializeContext(ctx);
          const traceState = JSON.stringify(serialized[AGENT_TRACE_CONTEXT_KEY]);
          if (!includesIds) {
            expect(traceState).not.toContain("current-user");
            expect(traceState).not.toContain("initiator-user");
          }
          expect(traceState).not.toContain("auth-only-secret");
          ctx = await deserializeContext(serialized);
          await contextStorage.run(ctx, async () => {
            await hooks.publish({
              idempotencyKey: turnIdempotencyKey("child", turnId),
              sessionId: "child",
              turnId,
              type: "turn.completed",
            });
            await hooks.publish({
              idempotencyKey: sessionIdempotencyKey("child"),
              sessionId: "child",
              turnId,
              type: "session.waiting",
            });
          });
        }
        await runtime.forceFlush();
        const spans = runtime.exporter.getFinishedSpans();
        expect(spans).toHaveLength(2);
        for (const span of spans) {
          expect(span.attributes["agent.principal.current.type"]).toBe("service");
          expect(span.attributes["agent.principal.initiator.type"]).toBe("user");
          expect(span.attributes["agent.principal.current.id"]).toBe(
            includesIds ? "current-user" : undefined,
          );
          expect(span.attributes["agent.principal.initiator.id"]).toBe(
            includesIds ? "initiator-user" : undefined,
          );
        }
        const bytes = new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)!);
        expect(bytes).not.toContain("auth-only-secret");
        if (!includesIds) {
          expect(bytes).not.toContain("current-user");
          expect(bytes).not.toContain("initiator-user");
        }
      } finally {
        registered.mockRestore();
        await runtime.shutdown();
      }
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "exports a queryable %s activation outcome without relying on span events",
    async (outcome) => {
      const runtime = createRuntime();
      const ctx = contextFor("private");
      const hooks = runtime.hooks.forTrace!(traceContext("parent", "private"));
      const binding = bindInstrumentationRuntime(runtime, ctx, {
        agentName: "parent",
        rootSessionId: "parent",
        sessionId: "parent",
      })!;
      await contextStorage.run(ctx, async () => {
        await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
        const identity = {
          idempotencyKey: turnIdempotencyKey("parent", "turn_0"),
          sessionId: "parent",
          turnId: "turn_0",
        };
        await hooks.publish(
          outcome === "failed"
            ? { ...identity, type: "turn.failed", error: new Error("private failure") }
            : { ...identity, type: outcome === "completed" ? "turn.completed" : "turn.cancelled" },
        );
        await hooks.publish({
          idempotencyKey: sessionIdempotencyKey("parent"),
          sessionId: "parent",
          turnId: "turn_0",
          type: "session.waiting",
        });
      });
      await runtime.forceFlush();
      const spans = runtime.metadata.getFinishedSpans();
      const bytes = JsonTraceSerializer.serializeRequest(
        spans.map((span) => ({
          ...span,
          events: [],
          spanContext: () => span.spanContext(),
        })),
      )!;
      const serialized = new TextDecoder().decode(bytes);
      const [activation] = parseLocalTraceSegment(serialized, spans[0]!.spanContext().traceId);
      expect(activation?.attributes["agent.turn.outcome"]).toBe(outcome);
      expect(activation?.statusCode).toBe(outcome === "failed" ? 2 : 0);
      expect(serialized).not.toContain("private failure");
      await runtime.shutdown();
    },
  );
});

function normalizeTraceForest(
  spans: readonly LocalTraceSpan[],
  exported: readonly ReadableSpan[],
): string[] {
  const roots = spans.filter(
    (span) => span.parentSpanId === undefined && span.name.startsWith("invoke_agent "),
  );
  const aliases = new Map(
    roots.map((root) => [
      root.traceId,
      `${String(root.attributes["agent.name"] ?? root.name.slice("invoke_agent ".length))}:${String(
        root.attributes["agent.turn.id"] ?? "unknown",
      )}`,
    ]),
  );
  const byIdentity = new Map(spans.map((span) => [`${span.traceId}:${span.spanId}`, span]));
  const children = Map.groupBy(
    spans.filter((span) => span.parentSpanId !== undefined),
    (span) => `${span.traceId}:${span.parentSpanId!}`,
  );
  const conversationIds = [
    ...new Set(roots.map((root) => String(root.attributes["gen_ai.conversation.id"]))),
  ];
  const lines =
    conversationIds.length === 1 ? [`conversation ${conversationIds[0]}`] : ["conversation mixed"];
  for (const root of roots.toSorted((left, right) => {
    const sequence =
      Number(left.attributes["agent.turn.sequence"]) -
      Number(right.attributes["agent.turn.sequence"]);
    return sequence || aliases.get(left.traceId)!.localeCompare(aliases.get(right.traceId)!);
  })) {
    const alias = aliases.get(root.traceId)!;
    const channelKind = root.attributes["agent.channel.kind"];
    const channelName = root.attributes["agent.channel.name"];
    const deliveryId = root.attributes["agent.channel.delivery.id"];
    lines.push(
      `trace ${alias} outcome=${String(root.attributes["agent.turn.outcome"] ?? "unknown")}${
        deliveryId === undefined
          ? ""
          : ` channel=${String(channelKind)}:${String(channelName)} delivery=${String(deliveryId)}`
      }`,
    );
    const links = exported
      .filter((span) => span.spanContext().traceId === root.traceId)
      .flatMap((span) =>
        span.links.map((link) => {
          const target = byIdentity.get(`${link.context.traceId}:${link.context.spanId}`);
          const type = String(link.attributes?.["eve.link.type"] ?? "unknown");
          return `  invoked from ${
            target === undefined
              ? "external"
              : `${aliases.get(target.traceId)}/${spanLabel(target)}`
          } via ${type}`;
        }),
      )
      .sort();
    lines.push(...links);
    appendTree(root, 1);
  }
  return lines;

  function appendTree(span: LocalTraceSpan, depth: number): void {
    lines.push(`${"  ".repeat(depth)}${spanLabel(span)}`);
    for (const child of (children.get(`${span.traceId}:${span.spanId}`) ?? []).toSorted(
      (left, right) => spanLabel(left).localeCompare(spanLabel(right)),
    )) {
      appendTree(child, depth + 1);
    }
  }
}

function spanLabel(span: LocalTraceSpan): string {
  if (span.name === "agent.action") {
    const role = span.attributes["agent.invocation.role"] === "caller" ? " role=caller" : "";
    return `agent.action ${String(span.attributes["agent.action.name"])}${role}`;
  }
  if (span.name === "agent.approval") {
    return `agent.approval ${String(span.attributes["agent.approval.outcome"])}`;
  }
  return span.name;
}
