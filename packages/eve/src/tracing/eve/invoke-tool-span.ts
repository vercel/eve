import { instrumentationScope } from "#instrumentation/scope.js";
import { context as otelContext, type Context } from "#compiled/@opentelemetry/api/index.js";

import type { InvokeToolResult } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { buildConversationContext } from "#channel/conversation-context.js";
import {
  toolCallIdempotencyKey,
  type InstrumentationScope,
  type InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { createLogger, formatError } from "#internal/logging.js";
import { applyLiveDeliveryAudienceCeiling } from "#shared/forwarded-trace-policy.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import {
  otelTelemetry,
  type Attributes,
  type SpanWriter,
} from "#compiled/@vercel/agent-runs/index.js";
import {
  contentAttribute,
  mcpLifecycle,
  withErrorContent,
} from "#compiled/@vercel/agent-runs/otel.js";
import { DIRECT_TOOL_CALL_ATTRIBUTE, DIRECT_TOOL_CALL_VALUE } from "#tracing/local/inspection.js";
import { markAgentTraceContext } from "#tracing/eve/agent-trace-context.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import {
  operationConversationId,
  withOperationTraceContext,
} from "#tracing/eve/conversation-context.js";
import { MCP_SERIALIZER } from "#tracing/eve/mcp.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";

const log = createLogger("invoke-tool");
// Built per call: the global tracer provider can be registered after this module loads.
const agentTelemetry = () =>
  otelTelemetry({ tracerName: "eve.agent", mapping: eveOutputMapping() });

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
 * Instrumentation providers get the same `call.requested` and
 * `call.settled` events, and the `execute_tool` span carries the same
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
    readonly input: unknown;
    readonly callId: string;
    readonly origin: InvokeToolTraceOrigin | undefined;
    /** The call's own run id, never a tool session's: traces see each call as one run. */
    readonly sessionId: string;
    readonly toolName: string;
  },
  run: (observer: InvokeToolObserver) => Promise<InvokeToolResult>,
): Promise<InvokeToolResult> {
  const base = withErrorContent(otelContext.active(), false);
  const runtime = getInstrumentationRuntime();
  try {
    return await otelContext.with(base, () => traced(input, base, run));
  } finally {
    await runtime?.forceFlush().catch((error: unknown) => {
      log.warn("flushing a tool call's trace failed", { error: formatError(error) });
    });
  }
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
  const telemetry = agentTelemetry();

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
  const scope: InstrumentationScope = instrumentationScope(
    {
      runId: input.callId,
      attempt: 0,
      channelAudience: conversation.audience,
      functionId: input.agentName,
      rootSessionId: input.sessionId,
      sessionId: input.sessionId,
      traceSessionId: input.sessionId,
    },
    0,
  );
  const events = toolCallEvents(hooks, scope, input);

  const settings = runtime.otelSettings;
  // No declared OpenTelemetry: eve emits no agent spans anywhere, so none here either.
  if (settings === undefined) return await events.run(run, undefined);

  const decision = resolveTracePolicy(
    settings.tracePolicy,
    { agentName: input.agentName, ...conversation },
    (error) =>
      log.warn("tracePolicy threw; dropping the tool call's trace", {
        error: formatError(error),
      }),
  );
  if (decision.action === "drop") {
    return await telemetry.suppressed!(() => events.run(run, undefined));
  }
  const content = applyLiveDeliveryAudienceCeiling(
    {
      ...decision,
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
  const parent = withOperationTraceContext(withChannelAudience(base, conversation.audience), scope);
  const attributes: Record<string, Attributes[string]> = {
    "agent.tool.is_framework": false,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": input.callId,
    "gen_ai.tool.name": input.toolName,
    "gen_ai.tool.type": "function",
    [DIRECT_TOOL_CALL_ATTRIBUTE]: DIRECT_TOOL_CALL_VALUE,
    "operation.name": "execute_tool",
    "resource.name": spanName,
    "agent.run.id": input.sessionId,
    "agent.trace.schema.version": 4,
    "gen_ai.conversation.id": operationConversationId({ sessionId: input.sessionId }),
  };
  if (process.env.VERCEL_ENV !== undefined) attributes["vercel.session_id"] = input.sessionId;
  if (input.origin !== undefined) {
    attributes["eve.channel.kind"] = conversation.channel.kind;
    attributes["eve.channel.name"] = input.origin.channelName;
  }
  const span = telemetry.startSpan(
    { type: "tool", operationId: input.callId, name: spanName, kind: "INTERNAL", attributes },
    { context: parent },
  );
  const capture = { emit: true, recordInputs, recordOutputs };
  // As on a conversation's tool span: error text inside the call follows the output decision.
  const host = markAgentTraceContext(withErrorContent(parent, recordOutputs));
  const mcp = mcpLifecycle({
    serializer: MCP_SERIALIZER,
    ...capture,
    write: (attributes) => setDefined(span, attributes),
    error: (error, errorType) => span.fail(recordOutputs ? error : undefined, errorType),
  });

  let failure: { readonly error: unknown } | undefined;
  const spanState = {
    failedWith: (error: unknown) => {
      failure = { error };
    },
    recordInputs,
    span,
  };
  try {
    const result = await telemetry.run(
      { type: "tool", reference: span.reference, capture, mcp },
      () => events.run(run, spanState),
      host,
    );
    span.setAttribute("eve.tool.outcome", result.outcome);
    if (result.outcome === "completed" && recordOutputs) {
      const output = contentAttribute(result.output);
      if (output !== undefined) span.setAttribute("gen_ai.tool.call.result", output);
    }
    if (result.outcome === "failed" && result.error.code === "INVALID_INPUT") {
      // A model-issued call with invalid input never runs, so it has no span to compare to.
      span.fail(undefined, "invalid-input");
    } else if (result.outcome === "failed") {
      // The conversation's rule: the error itself when outputs are recorded, else a generic one.
      span.fail(
        recordOutputs ? failure?.error : undefined,
        failure === undefined ? result.outcome : undefined,
      );
    }
    return result;
  } catch (error) {
    span.fail(recordOutputs ? error : undefined);
    throw error;
  } finally {
    span.end();
  }
}

const silentObserver: InvokeToolObserver = {
  executed: async () => {},
  executing: async () => {},
  failedWith: () => {},
};

/**
 * Direct calls publish one pair around the complete invocation, including validation and
 * policy refusal. SDK execute timing remains separate from the final caller-visible outcome.
 */
function toolCallEvents(
  hooks: InstrumentationHooks,
  scope: InstrumentationScope,
  input: { readonly callId: string; readonly toolName: string; readonly input: unknown },
) {
  const capturesInputs = hooks.capturesInputs ?? hooks.capturesContent;
  const capturesOutputs = hooks.capturesOutputs ?? hooks.capturesContent;
  const idempotencyKey = toolCallIdempotencyKey(scope, input.callId, 0);
  return {
    async run(
      run: (observer: InvokeToolObserver) => Promise<InvokeToolResult>,
      spanState:
        | {
            readonly failedWith: (error: unknown) => void;
            readonly recordInputs: boolean;
            readonly span: SpanWriter;
          }
        | undefined,
    ): Promise<InvokeToolResult> {
      let durationMs: number | undefined;
      let failure: unknown;
      const observer: InvokeToolObserver = {
        async executing(checked) {
          if (spanState?.recordInputs) {
            const args = contentAttribute(checked);
            if (args !== undefined) spanState.span.setAttribute("gen_ai.tool.call.arguments", args);
          }
        },
        async executed(outcome) {
          durationMs = outcome.durationMs;
          spanState?.span.setAttribute("gen_ai.execute_tool.duration", durationMs / 1000);
        },
        failedWith(error) {
          failure = error;
          spanState?.failedWith(error);
        },
      };
      await hooks.publish({
        capability: { kind: "tool", name: input.toolName },
        callId: input.callId,
        frameworkTool: false,
        idempotencyKey,
        input: capturesInputs ? input.input : undefined,
        scope,
        toolName: input.toolName,
        type: "call.requested",
      });
      let result: InvokeToolResult;
      try {
        result = await run(observer);
      } catch (error) {
        await hooks.publish({
          durationMs,
          error: capturesOutputs ? error : undefined,
          idempotencyKey,
          outcome: "failed",
          scope,
          type: "call.settled",
        });
        throw error;
      }
      await hooks.publish({
        durationMs,
        idempotencyKey,
        outcome: result.outcome,
        scope,
        type: "call.settled",
        reason: result.outcome === "rejected" ? result.reason : undefined,
        cause: result.outcome === "rejected" ? result.cause : undefined,
        error:
          capturesOutputs && result.outcome === "failed" ? (failure ?? result.error) : undefined,
        output: capturesOutputs && result.outcome === "completed" ? result.output : undefined,
      });
      return result;
    },
  };
}

function setDefined(span: SpanWriter, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(name, value);
  }
}
