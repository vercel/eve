import { context as apiContext, trace as apiTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolSet } from "#harness/tools.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  createInstrumentationHooks,
  turnIdempotencyKey,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  registerInstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { defineJsonSchema } from "#tools/schema.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";

/**
 * One tool, run by a model in a conversation and by `invokeTool`, must export
 * the same `execute_tool` span and publish the same provider events. Only the
 * differences listed here are allowed, each because a direct call has no turn.
 */
const ALLOWED_ATTRIBUTE_DIFFERENCES = new Set([
  // Ids: a model picks a conversation's call id; a direct call mints its own session.
  "agent.run.id",
  "gen_ai.conversation.id",
  "gen_ai.tool.call.id",
  "vercel.session_id",
  // Direct-call markers: the processor's trace ownership and the call's result status.
  "eve.channel.kind",
  "eve.channel.name",
  "eve.tool.invocation",
  "eve.tool.outcome",
  // On the direct span here; the conversation's tool span gains it separately.
  "gen_ai.execute_tool.duration",
]);

const AGENT = "parity-agent";
const SECRET = "sentinel-parity-content";
const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};
const inputSchema = defineJsonSchema({
  additionalProperties: false,
  properties: { text: { type: "string" } },
  type: "object",
} as const);

function tool(name: string, execute: (input: { text?: string }) => unknown): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema,
    name,
  };
}

const tools = new Map(
  [
    tool("lookup", async ({ text }) =>
      apiTrace.getTracer("test.tool").startActiveSpan("nested lookup", (span) => {
        span.end();
        return { echoed: text };
      }),
    ),
    tool("explode", async ({ text }) => {
      throw new Error(`thrown ${text}`);
    }),
  ].map((definition) => [definition.name, definition]),
);

const directRuntime: InvokeToolRuntime = {
  agentName: AGENT,
  callbackBaseUrl: "https://agent.example",
  compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  manifest: {
    bindings: Object.fromEntries(
      [...tools.keys()].map((name) => [
        `source:${name}`,
        { owner: { kind: "application" } } as never,
      ]),
    ),
    tools: [...tools.keys()].map((name) => ({
      hasExecute: true,
      name,
      sourceId: `source:${name}`,
    })),
  },
  nodeId: "__root__",
  sandboxRegistry: { sandbox: null } as never,
  tools,
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let events: InstrumentationEvent[];

let idGenerator: AgentSpanIdGenerator;

function install(capturesContent: boolean, declareOtel = true) {
  const agent = createAgentOtelInstrumentation({
    frameworkVersion: "test",
    idGenerator,
    recordInputs: capturesContent,
    recordOutputs: capturesContent,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: provider.getTracer("eve.agent"),
  });
  const recorder = {
    events: Object.fromEntries(
      (["tool.call.started", "tool.call.completed", "tool.call.failed"] as const).map((type) => [
        type,
        (event: InstrumentationEvent) => void events.push(event),
      ]),
    ),
    name: "recorder",
    tracePolicy: () => ({
      emit: true,
      recordInputs: capturesContent,
      recordOutputs: capturesContent,
    }),
  };
  const runtime = {
    ...agent,
    forceFlush: () => provider.forceFlush(),
    hooks: createInstrumentationHooks([agent.hook, recorder]),
    otelSettings: declareOtel
      ? {
          recordInputs: capturesContent,
          recordOutputs: capturesContent,
          traceChannelRequests: false,
        }
      : undefined,
    ownsAgentSpans: true,
    shutdown: async () => undefined,
  };
  // The process keeps its first runtime; each case needs its own content decision.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  registerInstrumentationRuntime(runtime as never);
  return runtime;
}

/** Runs `toolName` the way a turn does: a model calls it inside a step and an action. */
async function runInConversation(
  runtime: ReturnType<typeof install>,
  toolName: string,
): Promise<void> {
  const sessionId = "conversation";
  const callId = "call-model";
  const trace = {
    agentName: AGENT,
    audience: "private" as const,
    channel: { kind: "http" as const },
    environment: "development" as const,
    principalType: alice.principalType,
  };
  const ctx = new ContextContainer();
  ctx.set(ChannelInstrumentationKey, { kind: "http", metadata: {} });
  ctx.set(ConversationContextKey, trace);
  ctx.set(AuthKey, alice);
  ctx.set(InitiatorAuthKey, alice);
  ctx.set(SessionIdKey, sessionId);
  ctx.setVirtualContext(SessionKey, {
    auth: { current: alice, initiator: alice },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const bound = bindInstrumentationRuntime(runtime as never, ctx, {
    agentName: AGENT,
    rootSessionId: sessionId,
    sessionId,
  })!;
  const hooks = runtime.hooks.forTrace!(trace);
  await contextStorage.run(ctx, async () => {
    await bound.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
    await bound.prepareExecution().runStep(
      {
        environment: "development",
        eveVersion: "test",
        hasInput: true,
        session: { sessionId },
      },
      async (step) => {
        const attempt = step.prepareAttempt({ attemptIndex: 0, stepIndex: 0, turnId: "turn_0" });
        const scope = attempt.scope;
        await hooks.publish({
          idempotencyKey: attemptIdempotencyKey(scope),
          operation: { modelId: "test", operationId: "ai.generateText", provider: "test" },
          scope,
          type: "step.attempt.started",
        });
        const actionKey = actionIdempotencyKey(sessionId, "turn_0", callId);
        await hooks.publish({
          callId,
          idempotencyKey: actionKey,
          input: { text: SECRET },
          kind: "tool-call",
          name: toolName,
          scope,
          type: "action.started",
        });
        await generateText({
          model: new MockLanguageModelV3({
            doGenerate: async () => ({
              content: [
                {
                  input: JSON.stringify({ text: SECRET }),
                  toolCallId: callId,
                  toolName,
                  type: "tool-call",
                },
              ],
              finishReason: { raw: undefined, unified: "tool-calls" },
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
              warnings: [],
            }),
          }),
          prompt: "Use the tool.",
          stopWhen: stepCountIs(1),
          telemetry: {
            integrations: [createAiSdkHookBridge(scope, hooks, runtime.runInContext)],
            isEnabled: true,
          },
          tools: buildToolSet({ tools }),
        });
        await hooks.publish({
          idempotencyKey: actionKey,
          outcome: "completed",
          output: { output: {}, type: "result" },
          scope,
          type: "action.completed",
        });
        await attempt.complete();
      },
    );
    await hooks.publish({
      idempotencyKey: turnIdempotencyKey(sessionId, "turn_0"),
      sessionId,
      turnId: "turn_0",
      type: "turn.completed",
    });
  });
  await runtime.forceFlush();
}

interface Captured {
  readonly events: readonly unknown[];
  readonly nestedParent: boolean | undefined;
  readonly span: ReturnType<typeof comparable>;
}

async function capture(
  capturesContent: boolean,
  toolName: string,
  path: "conversation" | "direct",
): Promise<Captured> {
  exporter.reset();
  events = [];
  const runtime = install(capturesContent);
  try {
    if (path === "direct") {
      await invokeTool(directRuntime, toolName, { text: SECRET }, { auth: alice });
    } else {
      await runInConversation(runtime, toolName);
    }
    await runtime.forceFlush();
    const spans = exporter.getFinishedSpans();
    const toolSpans = spans.filter((span) => span.name === `execute_tool ${toolName}`);
    expect(toolSpans).toHaveLength(1);
    const toolSpan = toolSpans[0]!;
    const nested = spans.find((span) => span.name === "nested lookup");
    return {
      events: events.map(comparableEvent),
      nestedParent:
        nested === undefined
          ? undefined
          : nested.parentSpanContext?.spanId === toolSpan.spanContext().spanId,
      span: comparable(toolSpan),
    };
  } finally {
    await runtime.shutdown();
  }
}

function comparable(span: ReadableSpan) {
  return {
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(([name]) => !ALLOWED_ATTRIBUTE_DIFFERENCES.has(name)),
    ),
    // Stack traces name different frames; the exception's type and message must match.
    exceptions: span.events
      .filter((event) => event.name === "exception")
      .map((event) => ({
        message: event.attributes?.["exception.message"],
        type: event.attributes?.["exception.type"],
      })),
    kind: span.kind,
    name: span.name,
    status: span.status,
  };
}

function comparableEvent(event: InstrumentationEvent) {
  const {
    idempotencyKey: _key,
    scope: _scope,
    ...rest
  } = event as InstrumentationEvent & {
    readonly idempotencyKey: string;
    readonly scope: unknown;
  };
  const shape: Record<string, unknown> = { ...rest };
  // Ids differ by construction, as on the span.
  if ("callId" in shape) shape.callId = "<call>";
  const output = shape.output as { readonly error?: unknown } | undefined;
  if (output?.error instanceof Error) {
    shape.output = { ...output, error: `${output.error.name}: ${output.error.message}` };
  }
  return shape;
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  idGenerator = new AgentSpanIdGenerator();
  provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  apiTrace.setGlobalTracerProvider(provider);
  apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(async () => {
  await provider.shutdown();
  apiTrace.disable();
  apiContext.disable();
});

describe.each([
  ["content on", true],
  ["content off", false],
])("invokeTool against a conversation's tool call, %s", (_label, capturesContent) => {
  it.each(["lookup", "explode"])("exports the same %s span and events", async (toolName) => {
    const conversation = await capture(capturesContent, toolName, "conversation");
    const direct = await capture(capturesContent, toolName, "direct");

    expect(direct.span).toEqual(conversation.span);
    expect(direct.events).toEqual(conversation.events);
    expect(direct.nestedParent).toBe(conversation.nestedParent);
    if (toolName === "lookup") expect(direct.nestedParent).toBe(true);

    // The content decision applies the same way on both paths.
    const text = JSON.stringify(direct.span);
    if (capturesContent) expect(text).toContain(SECRET);
    else expect(text).not.toContain(SECRET);
  });
});

describe("invokeTool without declared OpenTelemetry", () => {
  it("still publishes the tool call to providers, and exports no span", async () => {
    events = [];
    install(true, false);
    await invokeTool(directRuntime, "lookup", { text: SECRET }, { auth: alice });

    expect(events.map(comparableEvent)).toEqual([
      { callId: "<call>", input: { text: SECRET }, toolName: "lookup", type: "tool.call.started" },
      {
        output: { output: { echoed: SECRET }, type: "result" },
        type: "tool.call.completed",
      },
    ]);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["nested lookup"]);
  });
});
