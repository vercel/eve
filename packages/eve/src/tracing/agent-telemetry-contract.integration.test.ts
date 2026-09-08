import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "#compiled/@opentelemetry/api/index.js";

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
import { prepareAgentInvocationTrace } from "#tracing/agent-invocation-coordinator.js";
import {
  flushAgentInvocationTraces,
  settleAgentInvocationTrace,
} from "#tracing/agent-invocation-terminal.js";
import * as instrumentation from "#instrumentation/runtime.js";
import {
  assembleLocalTrace,
  isAgentTurnSpan,
  parseLocalTraceSegment,
} from "#tracing/local-trace-reader.js";
import { summarizeLocalTrace } from "#cli/commands/trace-detail.js";
import { buildConversationItems } from "#cli/dev/tui/traces/trace-conversation.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import {
  composeSpanExportPolicies,
  redactSpanInputs,
  redactSpanOutputs,
} from "#tracing/span-export-policy.js";

function createRuntime() {
  const exporter = new InMemorySpanExporter();
  const metadata = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
      contentFilteringProcessor(
        new SimpleSpanProcessor(metadata),
        composeSpanExportPolicies(redactSpanInputs(), redactSpanOutputs()),
      ),
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
    flushSettledInvocations: async () => {
      await agent.hook.flush?.();
    },
    forceFlush: async () => {
      await agent.hook.flush?.();
      await provider.forceFlush();
    },
    shutdown: () => provider.shutdown(),
  };
}

function contextFor(audience: "public" | "private") {
  const ctx = new ContextContainer();
  ctx.set(ChannelInstrumentationKey, { kind: "http", metadata: { audience } });
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
  it("flushes 1000 settled invocations without closing the session or retaining their errors", async () => {
    const runtime = createRuntime();
    const exporterFlush = vi.spyOn(runtime.provider, "forceFlush").mockImplementation(() => {
      throw new Error("Exporter unavailable");
    });
    const registered = vi
      .spyOn(instrumentation, "getInstrumentationRuntime")
      .mockReturnValue(runtime);
    let ctx = contextFor("public");
    const store = new ContextAgentTraceStateStore();
    const count = 1000;
    try {
      for (let index = 0; index < count; index++) {
        const callId = `nested-${index}`;
        contextStorage.run(ctx, () =>
          store.setInvocation(actionIdempotencyKey("parent", "turn_0", callId), {
            attemptIndex: 0,
            callId,
            channelAudience: "public",
            kind: "subagent-call",
            name: "child",
            parent: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
            parentActionCallId: "outer",
            recordOutputs: true,
            rootSessionId: "parent",
            sessionId: "parent",
            spanId: runtime.idGenerator.deriveSpanId(callId),
            startTimeMs: 1,
            stepIndex: 0,
            turnId: "turn_0",
            terminal: {
              acceptedAtMs: 2,
              error: new Error("private " + "x".repeat(16384)),
              outcome: index % 2 === 0 ? "failed" : "cancelled",
            },
          }),
        );
        const flushed = await flushAgentInvocationTraces(serializeContext(ctx));
        expect(JSON.stringify(flushed)).not.toContain("private ");
        ctx = await deserializeContext(flushed);
        contextStorage.run(ctx, () => expect(store.findInvocations("parent")).toEqual([]));
      }
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(count);
      for (const span of runtime.exporter.getFinishedSpans()) {
        expect(span.status.code).toBe(
          span.attributes["agent.action.outcome"] === "failed"
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
        );
      }
      await flushAgentInvocationTraces(serializeContext(ctx));
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(count);
      expect(exporterFlush).not.toHaveBeenCalled();
    } finally {
      exporterFlush.mockRestore();
      registered.mockRestore();
      await runtime.shutdown();
    }
  });

  it.each(["throw", "reject"] as const)(
    "preserves the settlement context when invocation materialization fails (%s)",
    async (failure) => {
      const runtime = createRuntime();
      const flush = vi.spyOn(runtime, "flushSettledInvocations").mockImplementation(() => {
        const error = new Error("Span processor unavailable");
        if (failure === "throw") throw error;
        return Promise.reject(error);
      });
      const registered = vi
        .spyOn(instrumentation, "getInstrumentationRuntime")
        .mockReturnValue(runtime);
      const serializedContext = { [AGENT_TRACE_CONTEXT_KEY]: {} };
      try {
        await expect(flushAgentInvocationTraces(serializedContext)).resolves.toBe(
          serializedContext,
        );
        expect(flush).toHaveBeenCalledOnce();
      } finally {
        registered.mockRestore();
        await runtime.shutdown();
      }
    },
  );

  it.each(["session.completed", "session.failed"] as const)(
    "only marks unfinished invocations as errors on %s",
    async (type) => {
      const runtime = createRuntime();
      const ctx = contextFor("public");
      const hooks = runtime.hooks.forTrace!({ agentName: "parent", audience: "public" });
      await contextStorage.run(ctx, async () => {
        const store = new ContextAgentTraceStateStore();
        store.setInvocation(actionIdempotencyKey("parent", "turn_0", "nested"), {
          attemptIndex: 0,
          callId: "nested",
          kind: "subagent-call",
          name: "child",
          parent: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
          parentActionCallId: "outer",
          rootSessionId: "parent",
          sessionId: "parent",
          spanId: "3".repeat(16),
          startTimeMs: 1,
          stepIndex: 0,
          turnId: "turn_0",
        });
        await hooks.publish({
          error: new Error("private failure"),
          idempotencyKey: sessionIdempotencyKey("parent"),
          sessionId: "parent",
          type,
        });
        expect(store.findInvocations("parent")).toEqual([]);
      });
      const [span] = runtime.exporter.getFinishedSpans();
      expect(span?.attributes["agent.action.outcome"]).toBe(
        type === "session.failed" ? "failed" : "abandoned",
      );
      expect(span?.status.code).toBe(
        type === "session.failed" ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
      );
      await runtime.shutdown();
    },
  );

  it.each(["public", "private"] as const)(
    "round-trips %s channel, approval, delegated error and usage spans through the readers",
    async (audience) => {
      const runtime = createRuntime();
      let parent = contextFor(audience);
      parent.set(ConversationIdKey, "original-conversation");
      const scope = scopeFor("parent", audience);
      const hooks = runtime.hooks.forTrace!({ agentName: "parent", audience });
      const actionKey = actionIdempotencyKey("parent", "turn_0", "workflow");
      const operation = { modelId: "test", operationId: "ai.streamText", provider: "test" };
      const binding = bindInstrumentationRuntime(runtime, parent, {
        agentName: "parent",
        rootSessionId: "parent",
        sessionId: "parent",
      })!;
      let dispatch: ReturnType<typeof prepareAgentInvocationTrace>;
      await contextStorage.run(parent, async () => {
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
              { channelKind: "http", channelName: "web", deliveryId: "delivery", payloadIndex: 0 },
            ],
          },
        });
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
          name: "coordinate",
          scope,
          type: "action.started",
        });
        await hooks.publish({
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
        dispatch = prepareAgentInvocationTrace({
          channelMetadata: parent.get(ChannelInstrumentationKey),
          invocation: { callId: "nested", kind: "subagent-call", name: "child" },
          ownerId: "workflow-run",
          startTimeMs: Date.now(),
          serializedContext: serializeContext(parent),
          sessionId: "parent",
          turnId: "turn_0",
          sessionState: {
            "eve.runtime.workflowToolRuns": [
              {
                callId: "workflow",
                hookToken: "hook",
                runId: "workflow-run",
                toolName: "coordinate",
              },
            ],
          },
        });
      });
      parent = await deserializeContext(dispatch!.serializedContext);
      const child = contextFor(audience);
      child.set(ConversationIdKey, dispatch!.dispatch.conversationId!);
      child.set(ParentSessionKey, {
        callId: "nested",
        rootSessionId: "parent",
        sessionId: "parent",
        turn: { id: "turn_0", sequence: 0 },
      });
      if (dispatch!.dispatch.parentTraceContext !== undefined) {
        child.set(ParentTraceContextKey, dispatch!.dispatch.parentTraceContext);
        child.set(SessionTraceSeedKey, {
          ...dispatch!.dispatch.parentTraceContext,
          spanId: runtime.idGenerator.allocateSpanId(),
          traceId: runtime.idGenerator.generateTraceId(),
        });
      }
      const childScope = scopeFor("child", audience);
      const childHooks = runtime.hooks.forTrace!({ agentName: "child", audience });
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
        const modelKey = modelCallIdempotencyKey(childScope, 0);
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
      const settled = settleAgentInvocationTrace({
        acceptedAtMs: Date.now(),
        serializedContext: serializeContext(parent),
        sessionId: "parent",
        result: {
          callId: "nested",
          kind: "subagent-result",
          origin: "child",
          subagentName: "child",
          output: "private failure",
          outcome: {
            kind: "terminal",
            result: { kind: "failed", error: { message: "private failure" } },
            usageDelta: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 4,
              cacheWriteTokens: 2,
            },
          },
        },
      });
      if (audience === "private") expect(JSON.stringify(settled)).not.toContain("private failure");
      parent = await deserializeContext(settled);
      await contextStorage.run(parent, async () => {
        await runtime.forceFlush();
        expect(
          runtime.exporter
            .getFinishedSpans()
            .filter((span) => span.attributes["agent.invocation.role"] === "caller"),
        ).toHaveLength(1);
        expect(new ContextAgentTraceStateStore().findInvocations("parent")).toEqual([]);
        await hooks.publish({
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
          type: "action.completed",
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
      await runtime.forceFlush();
      const exported = runtime.exporter.getFinishedSpans();
      const bytes = JsonTraceSerializer.serializeRequest(exported)!;
      const traceIds = [...new Set(exported.map((span) => span.spanContext().traceId))];
      expect(traceIds).toHaveLength(2);
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
        expect(span.attributes).not.toHaveProperty("agent.session.id");
        expect(span.attributes).not.toHaveProperty("vercel.session_id");
      }
      expect(
        parsed
          .filter((span) => span.parentSpanId === undefined)
          .map((span) => span.name)
          .sort(),
      ).toEqual(["invoke_agent child", "invoke_agent parent"]);
      expect(parsed.filter(isAgentTurnSpan)).toHaveLength(2);
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
      const caller = parsed.find((span) => span.attributes["agent.invocation.role"] === "caller")!;
      const activation = parsed.find(
        (span) => span.name === "invoke_agent child" && isAgentTurnSpan(span),
      )!;
      const parentActivation = parsed.find(
        (span) => span.name === "invoke_agent parent" && isAgentTurnSpan(span),
      )!;
      expect(activation.parentSpanId).toBeUndefined();
      expect(activation.traceId).not.toBe(caller.traceId);
      expect(parentActivation.attributes).toMatchObject({
        "agent.channel.delivery.id": "delivery",
        "agent.channel.kind": "http",
        "agent.channel.name": "web",
      });
      const childSpan = exported.find((span) => span.spanContext().spanId === activation.spanId)!;
      expect(activation.attributes).toMatchObject({
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "agent.usage.input_tokens": 10,
        "agent.usage.output_tokens": 5,
      });
      expect(caller.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(caller.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
      expect(childSpan.links).toEqual([
        {
          context: expect.objectContaining({ spanId: caller.spanId, traceId: caller.traceId }),
          attributes: { "eve.link.type": "agent.dispatch" },
        },
      ]);
      expect(parsed.map((span) => span.name).sort()).toEqual(
        [
          "agent.action",
          "agent.action",
          "agent.approval",
          "agent.step",
          "agent.step",
          "chat test",
          "execute_tool coordinate",
          "invoke_agent child",
          "invoke_agent parent",
        ].sort(),
      );
      expect(summarizeLocalTrace(parsed)).toMatchObject({
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
      else expect(new TextDecoder().decode(bytes)).toContain("private failure");
      await runtime.shutdown();
    },
  );

  it("exports new current principals but the same initiator on resumed activations", async () => {
    const runtime = createRuntime();
    const ctx = contextFor("public");
    const hooks = runtime.hooks.forTrace!({ agentName: "parent", audience: "public" });
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
      const runtime = createRuntime();
      const hooks = runtime.hooks.forTrace!({ agentName: "child", audience: "public" });
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
      const hooks = runtime.hooks.forTrace!({ agentName: "parent", audience: "private" });
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
