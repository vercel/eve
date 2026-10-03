import { context as apiContext, propagation, trace as apiTrace } from "@opentelemetry/api";
import {
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
import {
  actionIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationEvent,
  type InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";
import { defineJsonSchema } from "#tools/schema.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { collectOtelPipeline, otel, otelIntegration } from "#tracing/otel-declaration.js";

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
let events: InstrumentationEvent[];
let runtime: InstrumentationRuntime | undefined;
let conversations = 0;

type Policy = "record" | "inputs only" | "none";
const POLICIES: Readonly<Record<Policy, ReturnType<TraceCapturePolicy>>> = {
  "inputs only": { emit: true, recordInputs: true, recordOutputs: false },
  none: { emit: true, recordInputs: false, recordOutputs: false },
  record: { emit: true, recordInputs: true, recordOutputs: true },
};

/**
 * Installs the runtime a deployment builds from `otel({ tracePolicy })` and a
 * span-processor destination, plus a provider that records tool events under
 * the same policy. Both paths read their content decision from it.
 */
function install(
  policy: Policy,
  options: { readonly declareOtel?: boolean; readonly slowStartMs?: number } = {},
): InstrumentationRuntime {
  const tracePolicy: TraceCapturePolicy = () => POLICIES[policy];
  const recorder: InstrumentationProviderDefinition = {
    events: {
      "tool.call.completed": (event) => void events.push(event),
      "tool.call.failed": (event) => void events.push(event),
      "tool.call.started": async (event) => {
        events.push(event);
        if (options.slowStartMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.slowStartMs));
        }
      },
    },
    name: "recorder",
    tracePolicy,
  };
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  runtime = installInstrumentationRuntime({
    collected: collectOtelPipeline(
      options.declareOtel === false
        ? []
        : [
            otel({ tracePolicy }),
            otelIntegration({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
          ],
    ),
    frameworkVersion: "test",
    providers: [recorder],
    serviceName: "parity",
  });
  return runtime;
}

/**
 * Runs `toolName` the way a turn does: the model call gets the attempt's own
 * telemetry, so the AI SDK hook bridge publishes the tool events, inside an
 * action as the harness reports it.
 */
async function runInConversation(toolName: string, modelInput: string): Promise<void> {
  // A fresh session per run: agent trace state is keyed by session and turn.
  const sessionId = `conversation-${++conversations}`;
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
  const bound = bindInstrumentationRuntime(runtime!, ctx, {
    agentName: AGENT,
    rootSessionId: sessionId,
    sessionId,
  })!;
  const hooks = runtime!.hooks.forTrace!({ ...trace });
  await contextStorage.run(ctx, async () => {
    await bound.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn_0" });
    await bound
      .prepareExecution()
      .runStep(
        { environment: "development", eveVersion: "test", hasInput: true, session: { sessionId } },
        async (step) => {
          const attempt = step.prepareAttempt({ attemptIndex: 0, stepIndex: 0, turnId: "turn_0" });
          const scope = attempt.scope;
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
                content: [{ input: modelInput, toolCallId: callId, toolName, type: "tool-call" }],
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
            telemetry: attempt.telemetry,
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
}

interface Captured {
  readonly events: readonly unknown[];
  readonly nestedParent: boolean | undefined;
  readonly raw: ReadableSpan;
  readonly span: ReturnType<typeof comparable>;
}

async function capture(run: () => Promise<unknown>, toolName: string): Promise<Captured> {
  exporter.reset();
  events = [];
  await run();
  await runtime!.forceFlush();
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
    raw: toolSpan,
    span: comparable(toolSpan),
  };
}

const direct = (toolName: string, input: unknown) => () =>
  invokeTool(directRuntime, toolName, input, { auth: alice });

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
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  apiTrace.disable();
  apiContext.disable();
  propagation.disable();
});

const ARGUMENTS = JSON.stringify({ text: SECRET });

describe.each<Policy>(["record", "inputs only", "none"])(
  "invokeTool against a conversation's tool call, tracePolicy %s",
  (policy) => {
    it.each(["lookup", "explode"])("exports the same %s span and events", async (toolName) => {
      install(policy);
      const conversation = await capture(() => runInConversation(toolName, ARGUMENTS), toolName);
      const viaInvoke = await capture(direct(toolName, { text: SECRET }), toolName);

      expect(viaInvoke.span).toEqual(conversation.span);
      expect(viaInvoke.events).toEqual(conversation.events);
      expect(viaInvoke.nestedParent).toBe(conversation.nestedParent);
      if (toolName === "lookup") expect(viaInvoke.nestedParent).toBe(true);

      // The policy applies the same way on both paths.
      const text = JSON.stringify(viaInvoke.span);
      expect(text.includes(SECRET)).toBe(policy !== "none");
      expect(viaInvoke.span.attributes["gen_ai.tool.call.result"] !== undefined).toBe(
        policy === "record" && toolName === "lookup",
      );
    });
  },
);

describe("invokeTool's recorded arguments", () => {
  it("records the checked input, as a conversation does for a call with no arguments", async () => {
    install("record");
    const conversation = await capture(() => runInConversation("lookup", ""), "lookup");
    const viaInvoke = await capture(direct("lookup", undefined), "lookup");

    expect(viaInvoke.span.attributes["gen_ai.tool.call.arguments"]).toBe("{}");
    expect(viaInvoke.span).toEqual(conversation.span);
    expect(viaInvoke.events).toEqual(conversation.events);
  });

  it("records a JSON string input as the object execute receives", async () => {
    install("record");
    const viaInvoke = await capture(direct("lookup", ARGUMENTS), "lookup");
    expect(viaInvoke.span.attributes["gen_ai.tool.call.arguments"]).toBe(ARGUMENTS);
  });

  it("records no arguments for rejected input", async () => {
    install("record");
    const viaInvoke = await capture(direct("lookup", { text: 7, secret: SECRET }), "lookup");
    expect(viaInvoke.raw.attributes["eve.tool.outcome"]).toBe("invalid-input");
    expect(viaInvoke.span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(viaInvoke.events).toEqual([]);
    expect(JSON.stringify(viaInvoke.span)).not.toContain(SECRET);
  });
});

describe("invokeTool's execute_tool duration", () => {
  it("counts execute only, not slow tool.call.started handlers", async () => {
    install("record", { slowStartMs: 150 });
    const viaInvoke = await capture(direct("lookup", { text: SECRET }), "lookup");

    const duration = viaInvoke.raw.attributes["gen_ai.execute_tool.duration"];
    expect(typeof duration).toBe("number");
    expect(duration as number).toBeLessThan(0.1);
    const [seconds, nanos] = viaInvoke.raw.duration;
    expect(seconds + nanos / 1e9).toBeGreaterThanOrEqual(0.14);
  });
});

describe("invokeTool without declared OpenTelemetry", () => {
  it("still publishes the tool call to providers, and exports no span", async () => {
    install("record", { declareOtel: false });
    events = [];
    await invokeTool(directRuntime, "lookup", { text: SECRET }, { auth: alice });

    expect(events.map(comparableEvent)).toEqual([
      { callId: "<call>", input: { text: SECRET }, toolName: "lookup", type: "tool.call.started" },
      { output: { output: { echoed: SECRET }, type: "result" }, type: "tool.call.completed" },
    ]);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
