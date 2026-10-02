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
 * Runs one direct tool call under an `execute_tool` span.
 *
 * A direct call has no turn, so the conversation path's lifecycle hooks never
 * see it; this is its whole instrumentation. The span records identity and
 * outcome, plus `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`
 * when the content decision allows them, which is the same decision the
 * conversation path's tool spans use: the OpenTelemetry declaration's content
 * setting, the trace policy, and the channel audience ceiling. Exception
 * text is never captured, on this span or on any span the call nests in or
 * under: error content is switched off for the whole call even when the
 * policy drops the span, so a failure logged inside the tool cannot land on
 * an already-active parent. That includes the trace policy itself: it runs
 * inside the protected context, and a policy that throws is logged as a
 * warning, which never touches a span.
 *
 * The span is marked as a direct call so trace processors treat it as the
 * call's activation: it claims the trace when it starts and completes it
 * when it ends. The call flushes the runtime afterwards so that completion
 * is released even on a deployment that only serves direct calls.
 */
export async function withInvokeToolSpan(
  input: {
    readonly auth: SessionAuthContext;
    readonly callId: string;
    /** The caller's arguments, recorded only when the content decision allows inputs. */
    readonly input: unknown;
    readonly origin: InvokeToolTraceOrigin | undefined;
    readonly sessionId: string;
    readonly toolName: string;
  },
  run: () => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const base = withErrorContent(otelContext.active(), false);
  return await otelContext.with(base, () => traced(input, base, run));
}

async function traced(
  input: Parameters<typeof withInvokeToolSpan>[0],
  base: Context,
  run: () => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const runtime = getInstrumentationRuntime();
  const settings = runtime?.otelSettings;
  // No declared OpenTelemetry: eve emits no agent spans anywhere, so none here either.
  if (settings === undefined) return await run();

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
    (error) =>
      log.warn("tracePolicy threw; dropping the tool call's trace", {
        error: formatError(error),
      }),
  );
  if (decision.action === "drop") return await otelContext.with(suppressTracing(base), run);
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
    attributes["gen_ai.agent.name"] = input.origin.agentName;
    attributes["eve.channel.kind"] = conversation.channel.kind;
    attributes["eve.channel.name"] = input.origin.channelName;
  }
  if (recordInputs) {
    const args = contentAttribute(input.input);
    if (args !== undefined) attributes["gen_ai.tool.call.arguments"] = args;
  }
  const span = trace
    .getTracer("eve.agent")
    .startSpan(spanName, { attributes, kind: SpanKind.INTERNAL }, parent);
  const active = markAgentTraceContext(
    withAgentToolSpanContext(trace.setSpan(parent, span), {
      recordInputs,
      recordOutputs,
      // Status only, whatever the content decision: exception text stays out of the trace.
      recordError: (_error, errorType) => recordAgentSpanError(span, undefined, errorType),
      setAttributes: (attributes) => setDefined(span, attributes),
    }),
  );

  try {
    const result = await otelContext.with(active, run);
    span.setAttribute("eve.tool.outcome", result.status);
    if (result.status === "completed" && recordOutputs) {
      const output = contentAttribute(result.output);
      if (output !== undefined) span.setAttribute("gen_ai.tool.call.result", output);
    }
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
    await runtime?.forceFlush().catch((error: unknown) => {
      log.warn("flushing a tool call's trace failed", { error: formatError(error) });
    });
  }
}

function setDefined(span: Span, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(name, value);
  }
}
