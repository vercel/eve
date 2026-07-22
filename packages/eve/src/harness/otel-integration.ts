import {
  context as otelContext,
  type Span,
  type SpanContext,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type TelemetryOptions } from "ai";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import type { HarnessSession } from "#harness/types.js";

let registered = false;

/**
 * Registers the AI SDK OpenTelemetry integration once so that model
 * calls emit OTel spans, including runtime-context attributes. Safe to
 * call multiple times — only the first call has an effect.
 *
 * In AI SDK v7 the built-in OTel tracing was moved to `@ai-sdk/otel`
 * and must be registered explicitly.
 */
export function ensureOtelIntegration(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerTelemetry(
    new OpenTelemetry({
      runtimeContext: true,
    }),
  );
}

/**
 * Builds the `telemetry` value for the AI SDK from authored settings.
 *
 * Custom context (authored `InstrumentationDefinition.events` plus
 * eve-specific identifiers such as `eve.session.id`) is flowed through
 * {@link buildTelemetryRuntimeContext} because AI SDK v7 surfaces
 * per-call attributes via `runtimeContext`, not a dedicated metadata field on
 * `TelemetryOptions`.
 */
export function enrichTelemetry(
  authored: InstrumentationDefinition | undefined,
  agentName: string | undefined,
  runtimeContext?: Readonly<Record<string, unknown>>,
): TelemetryOptions | undefined {
  if (authored === undefined) {
    return undefined;
  }

  // AI SDK telemetry redacts runtimeContext unless every exported key is
  // opted in. This context only contains sanitized instrumentation context.
  const includeRuntimeContext: Record<string, true> = {};
  for (const key of Object.keys(runtimeContext ?? {})) {
    includeRuntimeContext[key] = true;
  }

  return {
    functionId: authored.functionId ?? agentName,
    includeRuntimeContext,
    isEnabled: true,
    recordInputs: authored.recordInputs ?? true,
    recordOutputs: authored.recordOutputs ?? true,
  };
}

// ---------------------------------------------------------------------------
// Turn trace state — survives step boundaries via session.state
// ---------------------------------------------------------------------------

const TURN_TRACE_STATE_KEY = "eve.harness.turnTrace";

/**
 * Serializable subset of `SpanContext` stored on `session.state` so
 * continuation steps within the same turn can restore the parent trace.
 */
interface TurnTraceState {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

function getTurnTraceState(session: {
  readonly state?: Readonly<Record<string, unknown>>;
}): TurnTraceState | undefined {
  return session.state?.[TURN_TRACE_STATE_KEY] as TurnTraceState | undefined;
}

export function setTurnTraceState(
  session: HarnessSession,
  spanContext: SpanContext,
): HarnessSession {
  const stored: TurnTraceState = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };

  return {
    ...session,
    state: {
      ...session.state,
      [TURN_TRACE_STATE_KEY]: stored,
    },
  };
}

/**
 * Resolves the OTel context for the current step.
 *
 * First step of a turn: uses the newly created turn span.
 * Continuation steps: restores the parent span context from session state
 * so AI SDK spans nest under the same trace as the first step.
 */
export function resolveStepOtelContext(
  tracer: ReturnType<typeof trace.getTracer> | undefined,
  turnSpan: Span | undefined,
  session: { readonly state?: Readonly<Record<string, unknown>> },
): ReturnType<typeof otelContext.active> | undefined {
  if (turnSpan) {
    return trace.setSpan(otelContext.active(), turnSpan);
  }

  if (tracer) {
    const stored = getTurnTraceState(session);
    if (stored) {
      const parent = trace.wrapSpanContext({
        traceId: stored.traceId,
        spanId: stored.spanId,
        traceFlags: stored.traceFlags,
      });
      return trace.setSpan(otelContext.active(), parent);
    }
  }

  return undefined;
}
