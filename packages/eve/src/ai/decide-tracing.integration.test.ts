import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  ParentSessionKey,
  SessionIdKey,
  SessionKey,
  SessionTraceSeedKey,
  TraceRootKey,
} from "#context/keys.js";
import { ensureOtelIntegration } from "#instrumentation/ai-sdk-telemetry.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  registerInstrumentationRuntime,
  type ExecutionInstrumentation,
} from "#instrumentation/runtime.js";
import { decide } from "#public/ai/index.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";
import { createAgentOtelInstrumentation } from "#tracing/eve/agent-otel-provider.js";
import { ContextAgentTraceStateStore } from "#tracing/eve/agent-trace-context-store.js";
import { AgentSpanIdGenerator, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { withCapture } from "#compiled/@vercel/agent-runs/otel.js";
import { traceSessionIdFromContext } from "#tracing/eve/conversation-context.js";
import { InMemoryAgentTraceStateStore } from "#internal/testing/in-memory-agent-trace-state-store.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";

const questions = {
  team: {
    type: "choice",
    instructions: "Select the team that can help Alice.",
    criteria: { billing: "Invoices and payments", support: "Product questions" },
  },
} as const;
const state = { request: "Alice needs a copy of her invoice." };
const answer = {
  answers: { team: { type: "choice" as const, choice: "billing" } },
  usage: { inputTokens: 42, outputTokens: 3 },
  warnings: [],
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let idGenerator: AgentSpanIdGenerator;
let runtime: ReturnType<typeof useRuntime>;
let sampleTrace: boolean;

function useRuntime(
  tracePolicy?: TraceCapturePolicy,
  stateStore: AgentTraceStateStore = new ContextAgentTraceStateStore(),
  authored: readonly InstrumentationProviderDefinition[] = [],
) {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  const agent = createAgentOtelInstrumentation({
    environment: "production",
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore,
    telemetry: otelTelemetry({ provider, idGenerator, samplesTrace: () => sampleTrace }),
    tracePolicy,
  });
  return registerInstrumentationRuntime({
    ...agent,
    hooks: createInstrumentationHooks({
      serialBefore: [{ ...agent.hook, name: "internal:otel" }],
      parallel: authored,
    }),
    ownsAgentSpans: true,
    otelSettings: {
      traceChannelRequests: false,
      tracePolicy,
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  });
}

async function inSession<T>(
  execute: (ctx: ContextContainer, binding: ExecutionInstrumentation) => Promise<T>,
  configure?: (ctx: ContextContainer) => void,
): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "alice-session");
  ctx.set(SessionKey, {
    sessionId: "alice-session",
    auth: { current: null, initiator: null },
    turn: { id: "turn-1", sequence: 0 },
  });
  ctx.set(ConversationContextKey, {
    audience: "private",
    channel: { kind: "http" },
    environment: "production",
    principalType: "user",
  });
  configure?.(ctx);
  return contextStorage.run(ctx, async () => {
    const binding = bindInstrumentationRuntime(runtime, ctx, {
      agentName: "support",
      rootSessionId: "alice-session",
      sessionId: "alice-session",
    })!;
    await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn-1" });
    return execute(ctx, binding);
  });
}

function decisions() {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.attributes["gen_ai.operation.name"] === "decision");
}

beforeEach(() => {
  sampleTrace = true;
  exporter = new InMemorySpanExporter();
  idGenerator = new AgentSpanIdGenerator();
  provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  vi.stubGlobal("AI_SDK_TELEMETRY_INTEGRATIONS", []);
  runtime = useRuntime();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  vi.unstubAllGlobals();
});

describe("decide tracing", () => {
  it("emits one decision span under the active tool and parents provider work to it", async () => {
    ensureOtelIntegration();
    const model = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        trace.getTracer("test.provider").startSpan("decision request").end();
        return {
          ...answer,
          answers: { ...answer.answers, urgent: { type: "boolean", probability: 0.2 } },
          providerMetadata: { gateway: { generationId: "gen_alice", cost: "0.0004" } },
        };
      },
    });
    let parentId: string | undefined;
    await inSession(async (ctx) => {
      const turn = trace.setSpan(
        context.active(),
        trace.wrapSpanContext(ctx.require(SessionTraceSeedKey)),
      );
      await trace
        .getTracer("test.tool")
        .startActiveSpan("classify request", {}, turn, async (span) => {
          parentId = span.spanContext().spanId;
          try {
            const result = await decide({
              model,
              questions: {
                ...questions,
                urgent: { type: "boolean", instructions: "Does Alice need an urgent response?" },
              },
              state,
            });
            expect(result.answers.team.choice).toBe("billing");
          } finally {
            span.end();
          }
        });
    });

    expect(decisions()).toHaveLength(1);
    const decision = decisions()[0]!;
    expect(decision.name).toBe(`decision ${model.modelId}`);
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.attributes["gen_ai.request.model"] === model.modelId),
    ).toHaveLength(1);
    expect(decision.parentSpanContext?.spanId).toBe(parentId);
    expect(decision.attributes).toMatchObject({
      "gen_ai.provider.name": model.provider,
      "gen_ai.request.model": model.modelId,
      "gen_ai.usage.input_tokens": 42,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.generation.id": "gen_alice",
      "gen_ai.usage.cost": 0.0004,
    });
    const request = exporter.getFinishedSpans().find((span) => span.name === "decision request")!;
    expect(request.parentSpanContext?.spanId).toBe(decision.spanContext().spanId);
    expect(JSON.stringify(decision.attributes)).not.toContain(state.request);
    expect(JSON.stringify(decision.attributes)).not.toContain(questions.team.instructions);
  });

  it.each([
    { firstSampled: true, asyncStore: false },
    { firstSampled: false, asyncStore: false },
    { firstSampled: true, asyncStore: true },
  ])(
    "parents routing decisions to each prepared turn (first sampled: $firstSampled, async store: $asyncStore)",
    async ({ firstSampled, asyncStore }) => {
      if (asyncStore) {
        const store = new InMemoryAgentTraceStateStore();
        runtime = useRuntime(undefined, {
          get: async (kind, key) => store.get(kind, key),
          set: store.set.bind(store),
          delete: store.delete.bind(store),
          update: store.update.bind(store),
          entries: store.entries.bind(store),
        });
      }
      sampleTrace = firstSampled;
      const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
      const expectedParents: { spanId: string; traceId: string }[] = [];
      await inSession(async (ctx, binding) => {
        if (firstSampled) expectedParents.push(ctx.require(SessionTraceSeedKey));
        await decide({ model, questions, state });
        sampleTrace = true;
        const nextTurn = await binding.preparePreamble({
          sequence: 1,
          sessionStarted: true,
          turnId: "turn-2",
        });
        expectedParents.push(nextTurn!);
        ctx.set(SessionKey, { ...ctx.require(SessionKey), turn: { id: "turn-2", sequence: 1 } });
        await decide({ model, questions, state });
      });
      expect(decisions()).toHaveLength(expectedParents.length);
      expect(
        decisions().map((span) => ({
          spanId: span.parentSpanContext?.spanId,
          traceId: span.spanContext().traceId,
        })),
      ).toEqual(expectedParents.map(({ spanId, traceId }) => ({ spanId, traceId })));
    },
  );

  it.each([
    { root: { kind: "own" as const }, expected: "alice-session" },
    {
      root: { kind: "inherited" as const, sessionId: "remote-session" },
      expected: "remote-session",
    },
  ])("preserves the trace session for a remote $root.kind root", async ({ root, expected }) => {
    let traceSessionId: string | undefined;
    const model = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        traceSessionId = traceSessionIdFromContext(context.active());
        return answer;
      },
    });
    await inSession(
      async () => {
        await decide({ model, questions, state });
      },
      (ctx) => {
        ctx.set(ParentSessionKey, {
          callId: "remote-call",
          sessionId: "caller-session",
          rootSessionId: "caller-session",
          turn: { id: "caller-turn", sequence: 0 },
        });
        ctx.set(TraceRootKey, root);
      },
    );
    expect(traceSessionId).toBe(expected);
  });

  it("traces standalone calls using the resolved model rather than its alias", async () => {
    const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { decisionModel: () => model });
    await decide({ model: "internal-decider", questions, state });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.name).toBe(`decision ${model.modelId}`);
    expect(decisions()[0]!.attributes["gen_ai.request.model"]).toBe(model.modelId);
  });

  it.each(["provider", "validation", "abort"] as const)(
    "ends failed spans without leaking private %s errors",
    async (failure) => {
      const error = new Error("private invoice details");
      const model = new Experimental_DecisionMockModelV4({
        doDecide: async () => {
          if (failure === "provider") throw error;
          return failure === "validation" ? { answers: {}, warnings: [] } : answer;
        },
      });
      await inSession(async () => {
        await expect(
          decide({
            model,
            questions,
            state,
            maxRetries: 0,
            signal: failure === "abort" ? AbortSignal.abort(error) : undefined,
          }),
        ).rejects.toThrow();
      });
      expect(decisions()).toHaveLength(1);
      expect(decisions()[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(JSON.stringify(decisions()[0]!.events)).not.toContain(error.message);
      expect(JSON.stringify(decisions()[0]!.status)).not.toContain(error.message);
    },
  );

  it.each(["inputs", "outputs"] as const)(
    "does not leak redacted %s through SDK validation errors",
    async (redacted) => {
      const marker = "alice-invoice-private-content";
      runtime = useRuntime(() => ({
        emit: true,
        recordInputs: redacted !== "inputs",
        recordOutputs: redacted !== "outputs",
      }));
      const model = new Experimental_DecisionMockModelV4({
        doDecide: async () => ({
          ...answer,
          answers: { team: { type: "choice", choice: marker } },
        }),
      });
      await inSession(async () => {
        await expect(
          decide({
            model,
            questions,
            state: redacted === "inputs" ? { request: marker, invalid: Number.NaN } : state,
          }),
        ).rejects.toThrow();
      });
      expect(decisions()).toHaveLength(1);
      const span = decisions()[0]!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(
        JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }),
      ).not.toContain(marker);
    },
  );

  it("keeps a partial model refusal distinct from a request failure", async () => {
    const model = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({
        ...answer,
        answers: { ...answer.answers, urgent: { type: "refusal" } },
      }),
    });
    await inSession(async () => {
      await expect(
        decide({
          model,
          state,
          questions: {
            ...questions,
            urgent: { type: "boolean", instructions: "Does Alice need an urgent response?" },
          },
        }),
      ).rejects.toMatchObject({ questionIds: ["urgent"] });
    });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.status.code).toBe(SpanStatusCode.UNSET);
    expect(decisions()[0]!.attributes).not.toHaveProperty("error.type");
    expect(decisions()[0]!.attributes).not.toHaveProperty("gen_ai.decision.results");
  });

  it.each(["policy", "sampling", "undeclared", "inherited", "suppressed"] as const)(
    "does not emit a decision span when disabled by %s",
    async (disabled) => {
      if (disabled === "policy") runtime = useRuntime(() => false);
      if (disabled === "undeclared") runtime.otelSettings = undefined;
      if (disabled === "sampling") sampleTrace = false;
      const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
      await inSession(async () => {
        const run = () => decide({ model, questions, state });
        const result =
          disabled === "suppressed"
            ? await otelTelemetry().suppressed!(run)
            : disabled === "inherited"
              ? await context.with(
                  withCapture(context.active(), {
                    emit: false,
                    recordInputs: false,
                    recordOutputs: false,
                  }),
                  run,
                )
              : await run();
        expect(result.answers.team.choice).toBe("billing");
      });
      expect(decisions()).toHaveLength(0);
    },
  );
});

// AI SDK integrations such as Sentry's read content from the decision call, not from eve events.
describe("decide AI SDK integration content", () => {
  const allowsContent: InstrumentationProviderDefinition = {
    name: "sentry",
    tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  };

  it.each([
    ["declared", "no file allows", [], false],
    ["declared", "a file allows", [allowsContent], true],
    ["undeclared", "no file allows", [], false],
    ["undeclared", "a file allows", [allowsContent], true],
  ] as const)(
    "with OpenTelemetry %s, follows whether %s private content",
    async (otel, _files, authored, recordsContent) => {
      const seen: { recordInputs?: boolean; recordOutputs?: boolean }[] = [];
      vi.stubGlobal("AI_SDK_TELEMETRY_INTEGRATIONS", [
        {
          experimental_onDecisionModelCallStart: (event: (typeof seen)[number]) => seen.push(event),
        },
      ]);
      runtime = useRuntime(undefined, undefined, authored);
      if (otel === "undeclared") runtime.otelSettings = undefined;
      const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });

      await inSession(() => decide({ model, questions, state }));

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        recordInputs: recordsContent,
        recordOutputs: recordsContent,
      });
    },
  );
});
