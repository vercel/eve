import {
  context as otelContext,
  SpanKind,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "#compiled/@opentelemetry/api/index.js";

import type { InvokeToolResult } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { buildConversationContext } from "#channel/conversation-context.js";
import {
  toolCallIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { createLogger, formatError } from "#internal/logging.js";
import { applyLiveDeliveryAudienceCeiling } from "#shared/forwarded-trace-policy.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import {
  DIRECT_TOOL_CALL_ATTRIBUTE,
  DIRECT_TOOL_CALL_VALUE,
} from "#tracing/agent-span-contract.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";
import { withAgentToolSpanContext } from "#tracing/agent-tool-span-context.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";

const log = createLogger("invoke-tool");

/** Where a direct tool call came from, so trace policy can classify it like a conversation. */
export interface InvokeToolTraceOrigin {
  readonly adapter: ChannelAdapter<any>;
  readonly agentName: string;
  readonly channelName: string;
}

/**
 * Runs one direct tool call the way a conversation runs a model-issued one,
 * minus the turn around it.
 *
 * Instrumentation providers get the same `tool.call.started` and
 * `tool.call.completed` events, and the `execute_tool` span carries the same
 * attributes. Content follows the same decision: the OpenTelemetry
 * declaration's content setting, the trace policy, and the channel audience
 * ceiling. Arguments, the result, and error text are recorded only when that
 * decision allows them; otherwise a failure is a generic error. Error content
 * is switched off until the span exists, so a trace policy that throws, or a
 * call whose span is dropped, never writes error text to a parent span. A
 * throwing policy is logged as a warning, which never touches a span.
 *
 * The span is marked as a direct call so trace processors treat it as the
 * call's activation: it claims the trace when it starts and completes it
 * when it ends. The call flushes the runtime afterwards so that completion
 * is released even on a deployment that only serves direct calls.
 */
export async function withInvokeToolSpan(
  input: {
    /** The agent's name, on the span whether or not the call has a channel origin. */
    readonly agentName: string;
    readonly auth: SessionAuthContext;
    readonly callId: string;
    readonly origin: InvokeToolTraceOrigin | undefined;
    /** The call's own run id, never a tool session's: traces see each call as one run. */
    readonly sessionId: string;
    readonly toolName: string;
  },
  run: (observer: InvokeToolObserver) => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const base = withErrorContent(otelContext.active(), false);
  return await otelContext.with(base, () => traced(input, base, run));
}

/**
 * What the call reports while it runs, so providers and the span see the
 * same steps a model-issued call goes through.
 */
export interface InvokeToolObserver {
  /** The tool's `execute` is about to run with its checked input, the input the span records. */
  executing(input: unknown): Promise<void>;
  /**
   * `execute` settled with this output, or threw this error, after running
   * for `durationMs`: measured from just before `execute` to its settlement,
   * so provider handlers are not counted, as in the AI SDK.
   */
  executed(
    outcome: (
      | { readonly type: "result"; readonly output: unknown }
      | { readonly type: "error"; readonly error: unknown }
    ) & { readonly durationMs: number },
  ): Promise<void>;
  /** The error behind a `failed` result, recorded on the span when outputs are. */
  failedWith(error: unknown): void;
}

async function traced(
  input: Parameters<typeof withInvokeToolSpan>[0],
  base: Context,
  run: (observer: InvokeToolObserver) => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const runtime = getInstrumentationRuntime();
  if (runtime === undefined) return await run(silentObserver);

  const conversation = buildConversationContext(
    {
      adapter: input.origin?.adapter ?? { kind: "channel" },
      auth: input.auth,
      channelName: input.origin?.channelName,
    },
    resolveInstrumentationEnvironment(),
  );
  const hooks =
    runtime.hooks.forTrace?.({ agentName: input.agentName, ...conversation }) ?? runtime.hooks;
  const scope: InstrumentationAttemptScope = {
    attemptId: input.callId,
    attemptIndex: 0,
    channelAudience: conversation.audience,
    functionId: input.agentName,
    rootSessionId: input.sessionId,
    sessionId: input.sessionId,
    stepIndex: 0,
    traceSessionId: input.sessionId,
    // No turn exists; the call stands in for one, as its session context does.
    turnId: input.callId,
  };
  const events = toolCallEvents(hooks, scope, input);

  const settings = runtime.otelSettings;
  // No declared OpenTelemetry: eve emits no agent spans anywhere, so none here either.
  if (settings === undefined) return await run(events.observer(undefined));

  const decision = resolveTracePolicy(
    settings.tracePolicy,
    { agentName: input.agentName, ...conversation },
    (error) =>
      log.warn("tracePolicy threw; dropping the tool call's trace", {
        error: formatError(error),
      }),
  );
  if (decision.action === "drop") {
    return await otelContext.with(suppressTracing(base), () => run(events.observer(undefined)));
  }
  const content = applyLiveDeliveryAudienceCeiling(
    {
      action: "record",
      recordInputs: settings.recordInputs && decision.recordInputs,
      recordOutputs: settings.recordOutputs && decision.recordOutputs,
    },
    conversation.audience,
    undefined,
    conversation.environment,
  );
  const recordInputs = content.action === "record" && content.recordInputs;
  const recordOutputs = content.action === "record" && content.recordOutputs;

  const spanName = `execute_tool ${input.toolName}`;
  const parent = withChannelAudience(base, conversation.audience);
  const attributes: Attributes = {
    "agent.tool.is_framework": false,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": input.callId,
    "gen_ai.tool.name": input.toolName,
    "gen_ai.tool.type": "function",
    [DIRECT_TOOL_CALL_ATTRIBUTE]: DIRECT_TOOL_CALL_VALUE,
    ...agentSpanNamingAttributes(spanName, "execute_tool"),
    ...agentTraceIdentityAttributes({
      rootSessionId: input.sessionId,
      sessionId: input.sessionId,
      traceSessionId: input.sessionId,
    }),
  };
  if (input.origin !== undefined) {
    attributes["eve.channel.kind"] = conversation.channel.kind;
    attributes["eve.channel.name"] = input.origin.channelName;
  }
  const span = trace
    .getTracer("eve.agent")
    .startSpan(spanName, { attributes, kind: SpanKind.INTERNAL }, parent);
  // As on a conversation's tool span: error text inside the call follows the output decision.
  const active = markAgentTraceContext(
    withAgentToolSpanContext(withErrorContent(trace.setSpan(parent, span), recordOutputs), {
      recordInputs,
      recordOutputs,
      recordError: (error, errorType) =>
        recordAgentSpanError(span, recordOutputs ? error : undefined, errorType),
      setAttributes: (attributes) => setDefined(span, attributes),
    }),
  );

  let failure: { readonly error: unknown } | undefined;
  const observer = events.observer({
    failedWith: (error) => {
      failure = { error };
    },
    recordInputs,
    span,
  });
  try {
    const result = await otelContext.with(active, () => run(observer));
    span.setAttribute("eve.tool.outcome", result.status);
    if (result.status === "completed" && recordOutputs) {
      const output = contentAttribute(result.output);
      if (output !== undefined) span.setAttribute("gen_ai.tool.call.result", output);
    }
    if (result.status === "invalid-input") {
      // A model-issued call with invalid input never runs, so it has no span to compare to.
      recordAgentSpanError(span, undefined, result.status);
    } else if (result.status === "failed") {
      // The conversation's rule: the error itself when outputs are recorded, else a generic one.
      recordAgentSpanError(
        span,
        recordOutputs ? failure?.error : undefined,
        failure === undefined ? result.status : undefined,
      );
    }
    return result;
  } catch (error) {
    recordAgentSpanError(span, recordOutputs ? error : undefined);
    throw error;
  } finally {
    span.end();
    await runtime.forceFlush().catch((error: unknown) => {
      log.warn("flushing a tool call's trace failed", { error: formatError(error) });
    });
  }
}

const silentObserver: InvokeToolObserver = {
  executed: async () => {},
  executing: async () => {},
  failedWith: () => {},
};

/**
 * The `tool.call.*` events a model-issued call publishes, in the same shapes
 * (`instrumentation/ai-sdk-hook-bridge.ts`): started before `execute`, and
 * completed with its result or error after. Content is projected the same way.
 */
function toolCallEvents(
  hooks: InstrumentationHooks,
  scope: InstrumentationAttemptScope,
  input: { readonly callId: string; readonly toolName: string },
) {
  const capturesInputs = hooks.capturesInputs ?? hooks.capturesContent;
  const capturesOutputs = hooks.capturesOutputs ?? hooks.capturesContent;
  const idempotencyKey = toolCallIdempotencyKey(scope, input.callId, 0);
  return {
    observer(
      spanState:
        | {
            readonly failedWith: (error: unknown) => void;
            readonly recordInputs: boolean;
            readonly span: Span;
          }
        | undefined,
    ): InvokeToolObserver {
      return {
        async executing(toolInput) {
          // The checked input, as a conversation's span records it; rejected input never gets here.
          if (spanState?.recordInputs) {
            const args = contentAttribute(toolInput);
            if (args !== undefined) spanState.span.setAttribute("gen_ai.tool.call.arguments", args);
          }
          await hooks.publish(
            Object.freeze({
              callId: input.callId,
              idempotencyKey,
              input: capturesInputs ? toolInput : undefined,
              scope,
              toolName: input.toolName,
              type: "tool.call.started",
            }),
          );
        },
        async executed(outcome) {
          spanState?.span.setAttribute("gen_ai.execute_tool.duration", outcome.durationMs / 1000);
          const output =
            outcome.type === "result"
              ? capturesOutputs
                ? { output: outcome.output, type: "result" as const }
                : { type: "result" as const }
              : capturesOutputs
                ? { error: outcome.error, type: "error" as const }
                : { type: "error" as const };
          await hooks.publish(
            Object.freeze({
              durationMs: outcome.durationMs,
              idempotencyKey,
              output: Object.freeze(output),
              scope,
              type: "tool.call.completed",
              outcome: outcome.type === "result" ? "completed" : "failed",
            }),
          );
        },
        failedWith(error) {
          spanState?.failedWith(error);
        },
      };
    },
  };
}

function setDefined(span: Span, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(name, value);
  }
}
