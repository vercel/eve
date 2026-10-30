import { formatTraceparent } from "#protocol/traceparent.js";
import {
  context,
  ROOT_CONTEXT,
  trace,
  type SpanContext,
} from "#compiled/@opentelemetry/api/index.js";
import { otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import {
  activeTraceOperation,
  truncateTelemetryText,
  withErrorContent,
} from "#compiled/@vercel/agent-runs/otel.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { readInstrumentationSessionContext } from "#instrumentation/session-context.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import { ContextAgentTraceStateStore } from "#tracing/eve/agent-trace-context-store.js";
import { markAgentTraceContext } from "#tracing/eve/agent-trace-context.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";

const log = createLogger("connection.events");

/** Only carry a validated W3C identity across durable steps, never baggage or content policy. */
export function connectionEventTraceContext(value: unknown): SpanContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { traceId, spanId, traceFlags } = value as Partial<SpanContext>;
  if (
    typeof traceId !== "string" ||
    typeof spanId !== "string" ||
    (traceFlags !== 0 && traceFlags !== 1)
  )
    return undefined;
  const reference = { traceId, spanId, traceFlags };
  return formatTraceparent(reference) === undefined ? undefined : reference;
}

export function connectionEventAttributes(input: {
  connectionName: string;
  sessionId?: string;
  subscriptionId?: string;
  deliveryId?: string;
  bindingId?: string;
}): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    "agent.connection.name": input.connectionName,
    "agent.run.id": input.sessionId,
    "connect.subscription.id": input.subscriptionId,
    "connect.delivery.id": input.deliveryId,
    "eve.connection.event.binding.id": input.bindingId,
  }))
    if (value !== undefined) attributes[key] = truncateTelemetryText(value, 256);
  return attributes;
}

/** Preserve diagnostic categories without logging SDK request objects or provider response bodies. */
export function connectionEventError(error: unknown): Error {
  const summary = new Error("Connection event operation failed");
  if (
    error instanceof Error &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "AbortError",
      "TimeoutError",
      "MCPClientError",
    ].includes(error.name)
  )
    summary.name = error.name;
  if (typeof error !== "object" || error === null) return summary;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  const code = candidate.code;
  const status = candidate.statusCode ?? candidate.status;
  const safeCode =
    typeof code === "number" && Number.isFinite(code)
      ? code
      : typeof code === "string" &&
          [
            "invalid_delivery",
            "verification_unavailable",
            "configuration_error",
            "ETIMEDOUT",
            "ECONNRESET",
            "ECONNREFUSED",
            "ENOTFOUND",
            "EAI_AGAIN",
          ].includes(code)
        ? code
        : undefined;
  if (safeCode !== undefined) Object.assign(summary, { code: safeCode });
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    Object.assign(summary, { statusCode: status });
  return summary;
}

type EventOperation =
  | "catalog"
  | "subscribe"
  | "get"
  | "unsubscribe"
  | "onEvent"
  | "onGap"
  | "onTerminated";

/** No model turn is needed to restore a session's trace policy in a durable event step. */
export async function withConnectionEventSpan<T>(
  input: {
    ctx: AlsContext;
    connectionName: string;
    operation: EventOperation;
    subscriptionId?: string;
    deliveryId?: string;
    bindingId?: string;
    requestTraceContext?: SpanContext;
  },
  execute: (reference?: SpanContext) => Promise<T>,
): Promise<T> {
  return contextStorage.run(input.ctx, async () => {
    const runtime = getInstrumentationRuntime();
    const telemetry = otelTelemetry({
      tracerName: "eve.connection.events",
      mapping: eveOutputMapping(),
    });
    const settings = runtime?.otelSettings;
    const sessionId = input.ctx.require(SessionIdKey);
    const attributes = connectionEventAttributes({ ...input, sessionId });
    const run = async (reference?: SpanContext) => {
      try {
        return await execute(reference);
      } catch (error) {
        // SDK and callback errors can include tokens or event bodies. Keep logs structural, too.
        logError(log, "connection event operation failed", connectionEventError(error), {
          ...attributes,
          operation: input.operation,
        });
        throw error;
      }
    };
    if (settings === undefined) return telemetry.suppressed!(() => run());
    const saved = new ContextAgentTraceStateStore().get("session", sessionId);
    const session = readInstrumentationSessionContext(input.ctx);
    const decision =
      session.traceSeed?.decision ??
      saved?.decision ??
      resolveTracePolicy(settings.tracePolicy, {
        ...session.conversation,
        agentName: input.ctx.require(BundleKey).resolvedAgent.config?.name ?? "eve",
      });
    const active = activeTraceOperation();
    const reference =
      connectionEventTraceContext(input.requestTraceContext) ?? active?.reference ?? saved?.context;
    if (
      decision.action === "drop" ||
      active?.capture.emit === false ||
      (session.traceSeed !== undefined && (session.traceSeed.traceFlags & 1) === 0) ||
      (saved !== undefined && (saved.context.traceFlags & 1) === 0) ||
      (reference !== undefined && (reference.traceFlags & 1) === 0)
    )
      return telemetry.suppressed!(() => run());
    const parent =
      reference === undefined
        ? context.active()
        : trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(reference));
    const host = markAgentTraceContext(
      withErrorContent(withChannelAudience(parent, session.audience), false),
    );
    const name = `agent.connection.event.${input.operation}`;
    const span = telemetry.startSpan(
      {
        type: "step",
        operationId: name,
        name,
        kind: input.operation.startsWith("on") ? "CONSUMER" : "INTERNAL",
        attributes: { ...attributes, "operation.name": name, "resource.name": name },
      },
      { context: host },
    );
    try {
      const result = await telemetry.run(
        {
          type: "step",
          reference: span.reference,
          capture: { emit: true, recordInputs: false, recordOutputs: false },
        },
        () => run(connectionEventTraceContext(span.reference)),
        host,
      );
      if (
        ["subscribe", "get", "unsubscribe"].includes(input.operation) &&
        typeof result === "object" &&
        result !== null
      ) {
        const subscription = result as { id?: unknown; status?: unknown };
        if (typeof subscription.id === "string")
          span.setAttribute("connect.subscription.id", truncateTelemetryText(subscription.id, 256));
        if (
          typeof subscription.status === "string" &&
          ["pending", "active", "needs_auth", "stopped", "expired", "failed"].includes(
            subscription.status,
          )
        )
          span.setAttribute("connect.subscription.status", subscription.status);
      }
      span.setAttribute("eve.connection.event.outcome", "completed");
      span.setStatus("OK");
      return result;
    } catch (error) {
      span.setAttribute("eve.connection.event.outcome", "failed");
      span.fail(undefined, "connection_event_error");
      throw error;
    } finally {
      span.end();
      await runtime!.forceFlush().catch(() => log.warn("flushing connection event traces failed"));
    }
  });
}
