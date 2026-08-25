import type { ContextKey } from "#context/key.js";
import { ContextKey as ContextKeyCtor } from "#context/key.js";
import type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { InstrumentationCapture } from "#instrumentation/lifecycle.js";
import type {
  InstrumentationParentLineage,
  InstrumentationTraceContext,
} from "#instrumentation/lifecycle.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Opaque serialized session instrumentation plan.
 *
 * Execution may store, transport, and pass this to
 * {@link SessionInstrumentation.bindSession}, but must not inspect its
 * contents. The shape is private to `src/instrumentation/`.
 */
export interface SerializedSessionInstrumentation {
  readonly schemaVersion: 1;
  readonly data: JsonObject;
}

export const SessionInstrumentationPlanKey: ContextKey<SerializedSessionInstrumentation> =
  new ContextKeyCtor<SerializedSessionInstrumentation>("eve.sessionInstrumentationPlan");

/** Input to session instrumentation planning. */
export interface SessionInstrumentationPlanningInput {
  readonly agentName?: string;
  readonly channel?: ChannelInstrumentationProjection;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

/** Frozen session instrumentation facts, private to `src/instrumentation/`. */
export interface SessionInstrumentationPlanData {
  readonly agentName?: string;
  readonly audience: ChannelAudience;
  readonly channelType?: string;
  readonly channelKind?: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly sampled: boolean;
  readonly captureLevel: InstrumentationCapture;
  readonly isTraceContentVisible: boolean;
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
}

const SCHEMA_VERSION = 1 as const;

function isInstrumentationCaptureLevel(value: unknown): value is InstrumentationCapture {
  return value === "content" || value === "metadata";
}

function isInstrumentationTraceContext(value: unknown): value is InstrumentationTraceContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).traceId === "string" &&
    typeof (value as Record<string, unknown>).spanId === "string" &&
    typeof (value as Record<string, unknown>).traceFlags === "number"
  );
}

function isInstrumentationParentLineage(value: unknown): value is InstrumentationParentLineage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).callId === "string" &&
    typeof (value as Record<string, unknown>).sessionId === "string" &&
    typeof (value as Record<string, unknown>).turnId === "string"
  );
}

/**
 * Parses a {@link SerializedSessionInstrumentation} into its internal data
 * shape. Only callable from within `src/instrumentation/`.
 */
export function parseSessionInstrumentationPlan(
  plan: SerializedSessionInstrumentation,
): SessionInstrumentationPlanData | undefined {
  const data = plan.data;
  if (data === undefined || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const traceId = record["traceId"];
  const spanId = record["spanId"];
  const traceFlags = record["traceFlags"];
  if (typeof traceId !== "string" || typeof spanId !== "string" || typeof traceFlags !== "number") {
    return undefined;
  }
  const audience = normalizeChannelAudience(record["audience"]);
  const captureLevel = isInstrumentationCaptureLevel(record["captureLevel"])
    ? record["captureLevel"]
    : "metadata";
  const parentTraceContext = isInstrumentationTraceContext(record["parentTraceContext"])
    ? (record["parentTraceContext"] as InstrumentationTraceContext)
    : undefined;
  const parentLineage = isInstrumentationParentLineage(record["parentLineage"])
    ? (record["parentLineage"] as InstrumentationParentLineage)
    : undefined;
  return {
    agentName: typeof record["agentName"] === "string" ? record["agentName"] : undefined,
    audience,
    channelType: typeof record["channelType"] === "string" ? record["channelType"] : undefined,
    channelKind: typeof record["channelKind"] === "string" ? record["channelKind"] : undefined,
    traceId,
    spanId,
    traceFlags,
    sampled: (traceFlags & 0x01) === 0x01,
    captureLevel,
    isTraceContentVisible: record["isTraceContentVisible"] === true,
    recordInputs: typeof record["recordInputs"] === "boolean" ? record["recordInputs"] : undefined,
    recordOutputs:
      typeof record["recordOutputs"] === "boolean" ? record["recordOutputs"] : undefined,
    parentTraceContext,
    parentLineage,
    rootSessionId: typeof record["rootSessionId"] === "string" ? record["rootSessionId"] : "",
  };
}

function shouldCaptureContent(audience: ChannelAudience): boolean {
  if (audience === "public") return true;
  return audience === "unknown" && isEveDevEnvironment();
}

/**
 * Plans session instrumentation at {@code createSession} time. The returned
 * plan is frozen — adapter metadata changes after this point do not alter
 * instrumentation behavior.
 *
 * Planning rules:
 * - Root session: evaluate tracePolicy exactly once.
 * - Local subagent: inherit the parent's sampled decision and trace context.
 * - Remote session: incoming parent trace context is preserved as-is.
 * - No instrumentation runtime: produce an inert plan.
 */
export function planSessionInstrumentation(input: {
  readonly runtime?: InstrumentationPlanningRuntime;
  readonly session: SessionInstrumentationPlanningInput;
}): SerializedSessionInstrumentation {
  const { channel, parentTraceContext, parentLineage, rootSessionId } = input.session;
  const audience = normalizeChannelAudience(channel?.metadata.audience);
  const channelType = channel?.channelType;
  const channelKind = channel?.kind;
  const agentName = input.session.agentName;

  const runtime = input.runtime;

  if (parentTraceContext !== undefined) {
    const data: SessionInstrumentationPlanData = {
      agentName,
      audience,
      channelType,
      channelKind,
      traceId: parentTraceContext.traceId,
      spanId: parentTraceContext.spanId,
      traceFlags: parentTraceContext.traceFlags,
      sampled: (parentTraceContext.traceFlags & 0x01) === 0x01,
      captureLevel: resolveCaptureLevel(
        runtime,
        parentTraceContext.traceFlags & 0x01 ? true : false,
      ),
      isTraceContentVisible: shouldCaptureContent(audience),
      recordInputs: runtime?.otelSettings?.recordInputs,
      recordOutputs: runtime?.otelSettings?.recordOutputs,
      parentTraceContext,
      parentLineage,
      rootSessionId,
    };
    return { schemaVersion: SCHEMA_VERSION, data: data as unknown as JsonObject };
  }

  if (runtime?.idGenerator === undefined || runtime.otelSettings === undefined) {
    const data: SessionInstrumentationPlanData = {
      agentName,
      audience,
      channelType,
      channelKind,
      traceId: "",
      spanId: "",
      traceFlags: 0,
      sampled: false,
      captureLevel: "metadata",
      isTraceContentVisible: shouldCaptureContent(audience),
      rootSessionId,
    };
    return { schemaVersion: SCHEMA_VERSION, data: data as unknown as JsonObject };
  }

  const sampled = evaluateTracePolicySafe(runtime.otelSettings.tracePolicy, {
    agentName,
    audience,
    channelType,
  });

  const data: SessionInstrumentationPlanData = {
    agentName,
    audience,
    channelType,
    channelKind,
    traceId: runtime.idGenerator.generateTraceId(),
    spanId: runtime.idGenerator.allocateSpanId(),
    traceFlags: sampled ? 1 : 0,
    sampled,
    captureLevel: resolveCaptureLevel(runtime, sampled),
    isTraceContentVisible: shouldCaptureContent(audience),
    recordInputs: runtime.otelSettings.recordInputs,
    recordOutputs: runtime.otelSettings.recordOutputs,
    rootSessionId,
  };
  return { schemaVersion: SCHEMA_VERSION, data: data as unknown as JsonObject };
}

function resolveCaptureLevel(
  runtime: InstrumentationPlanningRuntime | undefined,
  sampled: boolean,
): InstrumentationCapture {
  if (sampled) return "content";
  if (
    runtime?.otelSettings?.recordInputs === true ||
    runtime?.otelSettings?.recordOutputs === true
  ) {
    return "content";
  }
  if (runtime?.hooks?.capturesContent === true) return "content";
  return "metadata";
}

function evaluateTracePolicySafe(
  policy:
    | ((trace: {
        readonly agentName?: string;
        readonly audience: ChannelAudience;
        readonly channelType?: string;
      }) => boolean)
    | undefined,
  trace: {
    readonly agentName?: string;
    readonly audience: ChannelAudience;
    readonly channelType?: string;
  },
): boolean {
  try {
    return policy?.(trace) ?? trace.audience === "public";
  } catch {
    return false;
  }
}

/** Subset of {@link InstrumentationRuntime} needed for planning. */
export interface InstrumentationPlanningRuntime {
  readonly idGenerator?: { allocateSpanId(): string; generateTraceId(): string };
  readonly otelSettings?: {
    readonly tracePolicy?: (trace: {
      readonly agentName?: string;
      readonly audience: ChannelAudience;
      readonly channelType?: string;
    }) => boolean;
    readonly recordInputs?: boolean;
    readonly recordOutputs?: boolean;
  };
  readonly hooks?: { readonly capturesContent: boolean };
}

// ---------- Workflow attribute helpers ----------

/** Returns the trace id from a serialized plan, when the trace is sampled. */
export function readPlanTraceId(
  plan: SerializedSessionInstrumentation | undefined,
): string | undefined {
  if (plan === undefined) return undefined;
  const data = parseSessionInstrumentationPlan(plan);
  if (data === undefined || !data.sampled) return undefined;
  return data.traceId.length > 0 ? data.traceId : undefined;
}

/** Returns the frozen content-visibility flag from a serialized plan. */
export function readPlanIsTraceContentVisible(
  plan: SerializedSessionInstrumentation | undefined,
): boolean {
  if (plan === undefined) return false;
  const data = parseSessionInstrumentationPlan(plan);
  return data?.isTraceContentVisible ?? false;
}

/** Returns the frozen channel kind from a serialized plan. */
export function readPlanChannelKind(
  plan: SerializedSessionInstrumentation | undefined,
): string | undefined {
  if (plan === undefined) return undefined;
  const data = parseSessionInstrumentationPlan(plan);
  const kind = data?.channelKind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

/** Returns the trace context for portable propagation, when the trace is sampled. */
export function readPlanTraceContext(
  plan: SerializedSessionInstrumentation | undefined,
): RuntimeTraceContext | undefined {
  if (plan === undefined) return undefined;
  const data = parseSessionInstrumentationPlan(plan);
  if (data === undefined || data.traceId.length === 0) return undefined;
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    traceFlags: data.traceFlags,
  };
}

// ---------- Session instrumentation controls ----------

/**
 * Telemetry options returned by {@link SessionInstrumentation.telemetryForAttempt}.
 * Mirrors the AI SDK's `TelemetryOptions` shape without importing from `ai`,
 * keeping the instrumentation contract provider-neutral.
 */
export interface SessionTelemetryOptions {
  readonly functionId?: string;
  readonly includeRuntimeContext?: Record<string, true>;
  readonly integrations?: readonly unknown[];
  readonly isEnabled: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

/** Structural event input published by the harness. */
export type InstrumentationEventInput =
  | { readonly type: "session.started"; readonly sessionId: string }
  | {
      readonly type: "session.completed" | "session.waiting" | "session.failed";
      readonly sessionId: string;
      readonly turnId?: string;
      readonly error?: unknown;
    }
  | {
      readonly type: "turn.started";
      readonly sessionId: string;
      readonly turnId: string;
      readonly sequence: number;
    }
  | {
      readonly type: "turn.completed" | "turn.cancelled" | "turn.failed";
      readonly sessionId: string;
      readonly turnId: string;
      readonly error?: unknown;
    };

/** Input to {@link SessionInstrumentation.preparePreamble}. */
export interface PreambleInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly sessionStarted: boolean;
}

/** Input to {@link SessionInstrumentation.telemetryForAttempt}. */
export interface AttemptInstrumentationInput {
  readonly agentName?: string;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

/** Input to {@link SessionInstrumentation.runStep}. */
export interface StepInstrumentationInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
}

/** Input to {@link SessionInstrumentation.propagationFor}. */
export interface ChildPropagationInput {
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

/** Propagation envelope for child agent dispatch. */
export interface InstrumentationPropagation {
  readonly traceContext?: InstrumentationTraceContext;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly isRemote?: boolean;
}

/**
 * Bound session instrumentation controls, produced by
 * {@link InstrumentationRuntime.bindSession} inside each worker step.
 *
 * Every method depends only on the frozen plan — none re-evaluate trace
 * policy, re-read channel metadata, or change the producer capture level.
 */
export interface SessionInstrumentation {
  publish(event: InstrumentationEventInput): Promise<void>;
  preparePreamble(input: PreambleInput): Promise<RuntimeTraceContext | undefined>;
  telemetryForAttempt(input: AttemptInstrumentationInput): SessionTelemetryOptions | undefined;
  runStep<T>(input: StepInstrumentationInput, execute: () => Promise<T>): Promise<T>;
  propagationFor(input: ChildPropagationInput): InstrumentationPropagation | undefined;
  forceFlush(): Promise<void>;
}
