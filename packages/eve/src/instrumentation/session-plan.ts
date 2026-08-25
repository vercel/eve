import type { ContextKey } from "#context/key.js";
import { ContextKey as ContextKeyCtor } from "#context/key.js";
import type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { InstrumentationCapture } from "#instrumentation/lifecycle.js";
import type {
  InstrumentationContextRunner,
  InstrumentationEvent,
  InstrumentationHooks,
  InstrumentationParentLineage,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceContext,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";
import type { InstrumentationRuntimeContextInput } from "#public/instrumentation/index.js";
import type { InstrumentationChannel } from "#public/instrumentation/index.js";

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
  readonly parentTraceIsRemote?: boolean;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
}

/** Frozen session instrumentation facts, private to `src/instrumentation/`. */
export interface SessionInstrumentationPlanData {
  readonly agentName?: string;
  readonly audience: ChannelAudience;
  readonly channelType?: string;
  readonly channelKind?: string;
  readonly channelMetadata: JsonObject;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly sampled: boolean;
  readonly captureLevel: InstrumentationCapture;
  readonly functionId?: string;
  readonly isTraceContentVisible: boolean;
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
}

const SCHEMA_VERSION = 1 as const;

function toJsonObject(data: SessionInstrumentationPlanData): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      result[key] = value as JsonValue;
    }
  }
  return result;
}

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
    channelMetadata:
      typeof record["channelMetadata"] === "object" && record["channelMetadata"] !== null
        ? parseJsonObject(record["channelMetadata"])
        : {},
    traceId,
    spanId,
    traceFlags,
    sampled: (traceFlags & 0x01) === 0x01,
    captureLevel,
    functionId: typeof record["functionId"] === "string" ? record["functionId"] : undefined,
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

/** @internal Migration-only workflow visibility for contexts without a plan. */
export function legacyTraceContentVisible(audience: unknown): boolean {
  return shouldCaptureContent(normalizeChannelAudience(audience));
}

/** @internal Migration-only trace id reader for contexts without a plan. */
export function readLegacyTraceId(seed: unknown): string | undefined {
  if (typeof seed !== "object" || seed === null) return undefined;
  const record = seed as Record<string, unknown>;
  const traceId = record["traceId"];
  const traceFlags = record["traceFlags"];
  if (typeof traceId !== "string" || typeof traceFlags !== "number") return undefined;
  return (traceFlags & 0x01) === 0x01 && traceId.length > 0 ? traceId : undefined;
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
  const channelMetadata = snapshotChannelMetadata(channel?.metadata);
  const agentName = input.session.agentName;

  const runtime = input.runtime;

  if (parentTraceContext !== undefined) {
    const incomingSampled = (parentTraceContext.traceFlags & 0x01) === 0x01;
    const sampled = input.session.parentTraceIsRemote
      ? incomingSampled &&
        evaluateTracePolicySafe(runtime?.otelSettings?.tracePolicy, {
          agentName,
          audience,
          channelType,
        })
      : incomingSampled;
    const effectiveParentTraceContext = {
      ...parentTraceContext,
      traceFlags: sampled
        ? parentTraceContext.traceFlags | 0x01
        : parentTraceContext.traceFlags & ~0x01,
    };
    const data: SessionInstrumentationPlanData = {
      agentName,
      audience,
      channelType,
      channelKind,
      channelMetadata,
      traceId: parentTraceContext.traceId,
      spanId: parentTraceContext.spanId,
      traceFlags: effectiveParentTraceContext.traceFlags,
      sampled,
      captureLevel: resolveCaptureLevel(runtime, sampled),
      functionId: runtime?.otelSettings?.functionId,
      isTraceContentVisible: shouldCaptureContent(audience),
      recordInputs: runtime?.otelSettings?.recordInputs,
      recordOutputs: runtime?.otelSettings?.recordOutputs,
      parentTraceContext: effectiveParentTraceContext,
      parentLineage,
      rootSessionId,
    };
    return { schemaVersion: SCHEMA_VERSION, data: toJsonObject(data) };
  }

  if (
    runtime?.idGenerator === undefined ||
    runtime.otelSettings === undefined ||
    runtime.prepareSessionTrace === undefined
  ) {
    const data: SessionInstrumentationPlanData = {
      agentName,
      audience,
      channelType,
      channelKind,
      channelMetadata,
      traceId: "",
      spanId: "",
      traceFlags: 0,
      sampled: false,
      captureLevel: resolveCaptureLevel(runtime, false),
      functionId: runtime?.otelSettings?.functionId,
      isTraceContentVisible: shouldCaptureContent(audience),
      recordInputs: runtime?.otelSettings?.recordInputs,
      recordOutputs: runtime?.otelSettings?.recordOutputs,
      rootSessionId,
    };
    return { schemaVersion: SCHEMA_VERSION, data: toJsonObject(data) };
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
    channelMetadata,
    traceId: runtime.idGenerator.generateTraceId(),
    spanId: runtime.idGenerator.allocateSpanId(),
    traceFlags: sampled ? 1 : 0,
    sampled,
    captureLevel: resolveCaptureLevel(runtime, sampled),
    functionId: runtime.otelSettings.functionId,
    isTraceContentVisible: shouldCaptureContent(audience),
    recordInputs: runtime.otelSettings.recordInputs,
    recordOutputs: runtime.otelSettings.recordOutputs,
    rootSessionId,
  };
  return { schemaVersion: SCHEMA_VERSION, data: toJsonObject(data) };
}

/** Builds a one-time migration plan while preserving an existing seed exactly. */
export function migrateSessionInstrumentation(input: {
  readonly runtime?: InstrumentationPlanningRuntime;
  readonly seed: InstrumentationTraceContext;
  readonly session: SessionInstrumentationPlanningInput;
}): SerializedSessionInstrumentation {
  const audience = normalizeChannelAudience(input.session.channel?.metadata.audience);
  const sampled = (input.seed.traceFlags & 0x01) === 0x01;
  const data: SessionInstrumentationPlanData = {
    agentName: input.session.agentName,
    audience,
    captureLevel: resolveCaptureLevel(input.runtime, sampled),
    channelKind: input.session.channel?.kind,
    channelMetadata: snapshotChannelMetadata(input.session.channel?.metadata),
    channelType: input.session.channel?.channelType,
    functionId: input.runtime?.otelSettings?.functionId,
    isTraceContentVisible: shouldCaptureContent(audience),
    recordInputs: input.runtime?.otelSettings?.recordInputs,
    recordOutputs: input.runtime?.otelSettings?.recordOutputs,
    rootSessionId: input.session.rootSessionId,
    sampled,
    spanId: input.seed.spanId,
    traceFlags: input.seed.traceFlags,
    traceId: input.seed.traceId,
  };
  return { schemaVersion: SCHEMA_VERSION, data: toJsonObject(data) };
}

function snapshotChannelMetadata(value: unknown): JsonObject {
  try {
    return parseJsonObject(value ?? {});
  } catch {
    return {};
  }
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
    readonly functionId?: string;
    readonly tracePolicy?: (trace: {
      readonly agentName?: string;
      readonly audience: ChannelAudience;
      readonly channelType?: string;
    }) => boolean;
    readonly recordInputs?: boolean;
    readonly recordOutputs?: boolean;
  };
  readonly hooks?: { readonly capturesContent: boolean };
  readonly prepareSessionTrace?: unknown;
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
export type InstrumentationEventInput = InstrumentationEvent;

/** Input to {@link SessionInstrumentation.preparePreamble}. */
export interface PreambleInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly sessionStarted: boolean;
  readonly traceContext?: RuntimeTraceContext;
}

/** Input to {@link SessionInstrumentation.telemetryForAttempt}. */
export interface AttemptInstrumentationInput {
  readonly agentName?: string;
  readonly bridgeIntegration?: unknown;
  readonly registeredIntegrations?: readonly unknown[];
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

/** Input to {@link SessionInstrumentation.runStep}. */
export interface StepInstrumentationInput {
  readonly agentName?: string;
  readonly environment: string;
  readonly eveVersion: string;
  readonly hasInput: boolean;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
}

export type SessionRuntimeContextResolver = (
  input: InstrumentationRuntimeContextInput,
) => JsonObject | undefined;

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
  /** @internal Transitional AI SDK bridge surface. */
  readonly hooks: InstrumentationHooks;
  readonly capturesContent: boolean;
  /** @internal Transitional AI SDK bridge surface. */
  readonly prepareSessionTrace?: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  /** @internal Transitional AI SDK bridge surface. */
  readonly prepareTurnTrace?: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  /** @internal Transitional AI SDK bridge surface. */
  readonly runInContext: InstrumentationContextRunner;
  /** @internal Transitional runtime-context bridge surface. */
  readonly runtimeContextResolvers?: readonly SessionRuntimeContextResolver[];
  readonly runtimeContextChannel: InstrumentationChannel;
  /** Whether AI SDK OTel integration must be installed for this session. */
  readonly usesOtel: boolean;
  publish(event: InstrumentationEventInput): Promise<void>;
  preparePreamble(input: PreambleInput): Promise<RuntimeTraceContext | undefined>;
  telemetryForAttempt(input: AttemptInstrumentationInput): SessionTelemetryOptions | undefined;
  runStep<T>(input: StepInstrumentationInput, execute: () => Promise<T>): Promise<T>;
  propagationFor(input: ChildPropagationInput): InstrumentationPropagation | undefined;
  forceFlush(): Promise<void>;
}
