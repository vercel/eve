import {
  context as otelContext,
  SpanKind,
  trace,
  type Attributes,
  type Span,
} from "#compiled/@opentelemetry/api/index.js";

import type { InvokeToolResult } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { buildConversationContext } from "#channel/conversation-context.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
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
 * Runs one direct tool call under an `execute_tool` span.
 *
 * A direct call has no turn, so the conversation path's lifecycle hooks never
 * see it; this is its whole instrumentation. The span records identity and
 * outcome only. Arguments, results, and exception text are never captured,
 * on this span or on any span the call nests in or under: error content is
 * switched off for the whole call even when the policy drops the span, so a
 * failure logged inside the tool cannot land on an already-active parent.
 */
export async function withInvokeToolSpan(
  input: {
    readonly auth: SessionAuthContext;
    readonly callId: string;
    readonly origin: InvokeToolTraceOrigin | undefined;
    readonly sessionId: string;
    readonly toolName: string;
  },
  run: () => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const base = withErrorContent(otelContext.active(), false);
  const settings = getInstrumentationRuntime()?.otelSettings;
  // No declared OpenTelemetry: eve emits no agent spans anywhere, so none here either.
  if (settings === undefined) return await otelContext.with(base, run);

  const conversation = buildConversationContext(
    {
      adapter: input.origin?.adapter ?? { kind: "channel" },
      auth: input.auth,
      channelName: input.origin?.channelName,
    },
    resolveInstrumentationEnvironment(),
  );
  const decision = resolveTracePolicy(
    settings.tracePolicy,
    { agentName: input.origin?.agentName ?? "", ...conversation },
    (error) => logError(log, "tracePolicy threw; dropping the tool call's trace", error),
  );
  if (decision.action === "drop") return await otelContext.with(suppressTracing(base), run);

  const spanName = `execute_tool ${input.toolName}`;
  const parent = withChannelAudience(base, conversation.audience);
  const attributes: Attributes = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": input.callId,
    "gen_ai.tool.name": input.toolName,
    "gen_ai.tool.type": "function",
    ...agentSpanNamingAttributes(spanName, "execute_tool"),
    ...agentTraceIdentityAttributes({
      rootSessionId: input.sessionId,
      sessionId: input.sessionId,
      traceSessionId: input.sessionId,
    }),
  };
  if (input.origin !== undefined) {
    attributes["gen_ai.agent.name"] = input.origin.agentName;
    attributes["eve.channel.kind"] = conversation.channel.kind;
    attributes["eve.channel.name"] = input.origin.channelName;
  }
  const span = trace
    .getTracer("eve.agent")
    .startSpan(spanName, { attributes, kind: SpanKind.INTERNAL }, parent);
  const active = markAgentTraceContext(
    withAgentToolSpanContext(trace.setSpan(parent, span), {
      recordInputs: false,
      recordOutputs: false,
      recordError: (_error, errorType) => recordAgentSpanError(span, undefined, errorType),
      setAttributes: (attributes) => setDefined(span, attributes),
    }),
  );

  try {
    const result = await otelContext.with(active, run);
    span.setAttribute("eve.tool.outcome", result.status);
    if (result.status === "failed" || result.status === "invalid-input") {
      recordAgentSpanError(span, undefined, result.status);
    }
    return result;
  } catch (error) {
    // Status only: the thrown error's text stays out of the trace.
    recordAgentSpanError(span, undefined, error instanceof Error ? error.name : undefined);
    throw error;
  } finally {
    span.end();
  }
}

function setDefined(span: Span, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(name, value);
  }
}
