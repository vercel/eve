import type { ModelMessage, SystemModelMessage } from "ai";

import type {
  ChannelInstrumentationProjection,
  SessionAuthContext,
  SessionParent,
} from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { contextStorage } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  ParentSessionKey,
} from "#context/keys.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeContextResolver } from "#tracing/otel-declaration.js";
import {
  normalizeInstrumentationChannelKind,
  resolveInstrumentationProjection,
} from "#internal/instrumentation.js";
import { createLogger, formatError } from "#internal/logging.js";
import type {
  InstrumentationChannel,
  InstrumentationRuntimeContext,
  InstrumentationStepStartedEventInput,
} from "#public/instrumentation/index.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

const log = createLogger("harness.instrumentation-runtime-context");

export interface BuildTelemetryRuntimeContextInput {
  readonly capturesContent: boolean;
  readonly context?: InstrumentationRuntimeContextSnapshot;
  readonly eveVersion: string;
  readonly emissionState: HarnessEmissionState;
  readonly environment: string;
  readonly modelInput: {
    readonly instructions: string | SystemModelMessage | undefined;
    readonly messages: readonly ModelMessage[];
  };
  readonly providerResolvers?: readonly RuntimeContextResolver[];
  readonly session: HarnessSession;
}

export interface InstrumentationRuntimeContextSnapshot {
  readonly channel?: ChannelInstrumentationProjection;
  readonly currentAuth: SessionAuthContext | null;
  readonly initiatorAuth: SessionAuthContext | null;
  readonly parent?: SessionParent;
}

export function snapshotInstrumentationRuntimeContext(
  context: AlsContext | undefined,
): InstrumentationRuntimeContextSnapshot {
  const currentAuth = context?.get(AuthKey) ?? null;
  return {
    channel: snapshotForInstrumentation(
      context?.get(ChannelInstrumentationKey),
      "channel.instrumentation",
    ),
    currentAuth: snapshotForInstrumentation(currentAuth, "session.auth.current") ?? null,
    initiatorAuth:
      snapshotForInstrumentation(
        context?.get(InitiatorAuthKey) ?? currentAuth,
        "session.auth.initiator",
      ) ?? null,
    parent: snapshotForInstrumentation(context?.get(ParentSessionKey), "session.parent"),
  };
}

/**
 * Builds per-model-call runtime context for AI SDK telemetry spans.
 *
 * Runtime context is parsed defensively. Invalid results, reserved `eve.*`
 * keys, and callback failures are warning-only.
 */
export function buildTelemetryRuntimeContext(
  input: BuildTelemetryRuntimeContextInput,
): Record<string, unknown> | undefined {
  const hasProviderResolvers =
    input.providerResolvers !== undefined && input.providerResolvers.length > 0;
  if (!hasProviderResolvers) {
    return undefined;
  }

  const providerRuntimeContext = resolveProviderRuntimeContext(input);
  const context = input.context ?? snapshotInstrumentationRuntimeContext(contextStorage.getStore());
  const projection = context.channel;

  return {
    ...providerRuntimeContext,
    "eve.channel.kind": normalizeInstrumentationChannelKind(projection?.kind),
    "eve.environment": input.environment,
    "eve.session.id": input.session.sessionId,
    "eve.step.index": String(input.emissionState.stepIndex),
    "eve.turn.id": input.emissionState.turnId,
    "eve.turn.sequence": String(input.emissionState.sequence),
    "eve.version": input.eveVersion,
  };
}

function buildInstrumentationStepStartedInput(
  input: Omit<BuildTelemetryRuntimeContextInput, "eveVersion" | "environment">,
): InstrumentationStepStartedEventInput {
  const context = input.context ?? snapshotInstrumentationRuntimeContext(contextStorage.getStore());
  const projection = context.channel;

  return {
    channel: {
      kind: normalizeInstrumentationChannelKind(projection?.kind),
      metadata: snapshotForInstrumentation(projection?.metadata, "channel.metadata") ?? {},
    } as InstrumentationChannel,
    modelInput: input.capturesContent
      ? (snapshotForInstrumentation(input.modelInput, "modelInput") ?? {
          instructions: undefined,
          messages: [],
        })
      : { instructions: undefined, messages: [] },
    session: {
      auth: projectSessionAuth(context),
      id: input.session.sessionId,
      parent: context.parent,
    },
    step: {
      index: input.emissionState.stepIndex,
    },
    turn: {
      id: input.emissionState.turnId,
      sequence: input.emissionState.sequence,
    },
  };
}

/**
 * Coerces a resolved authored runtime-context record into the public
 * {@link InstrumentationRuntimeContext} shape, dropping reserved `eve.*` keys
 * (warning-only). Returns `undefined` when nothing survives the filter.
 */
function filterAuthoredRuntimeContext(
  value: JsonObject,
  source: string,
): InstrumentationRuntimeContext | undefined {
  const runtimeContext: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("eve.")) {
      log.warn("ignoring reserved instrumentation runtime context key", { key, source });
      continue;
    }
    runtimeContext[key] = entry;
  }

  return Object.keys(runtimeContext).length > 0 ? runtimeContext : undefined;
}

/**
 * Collects `runtimeContext` contributions from every provider resolver,
 * invoking each with a snapshot of the model attempt. Failures are warning-only
 * so one destination cannot break the turn. Later destinations override earlier
 * ones on key collision.
 */
function resolveProviderRuntimeContext(
  input: BuildTelemetryRuntimeContextInput,
): InstrumentationRuntimeContext | undefined {
  const resolvers = input.providerResolvers;
  if (resolvers === undefined || resolvers.length === 0) {
    return undefined;
  }

  const merged: Record<string, JsonValue> = {};
  let contributed = false;

  for (const resolver of resolvers) {
    const source = "provider.runtimeContext";
    const invoke = () => {
      const stepStartedInput = buildInstrumentationStepStartedInput(input);
      return resolver(stepStartedInput);
    };
    const result = resolveInstrumentationProjection({
      invoke,
      log,
      source,
    });
    if (result === undefined) continue;

    const filtered = filterAuthoredRuntimeContext(result as JsonObject, source);
    if (filtered === undefined) continue;

    Object.assign(merged, filtered);
    contributed = true;
  }

  return contributed ? merged : undefined;
}

function projectSessionAuth(context: InstrumentationRuntimeContextSnapshot): {
  readonly current: SessionAuthContext | null;
  readonly initiator: SessionAuthContext | null;
} {
  return {
    current: context.currentAuth,
    initiator: context.initiatorAuth,
  };
}

/**
 * Returns a JSON-isolated deep copy of a live runtime value for handoff
 * to an authored instrumentation callback.
 *
 * The copy shares no references with runtime state, so a callback that
 * mutates it cannot reach back into the turn — isolation, not freezing,
 * is what this snapshot guarantees. Values that are not JSON-serializable
 * are dropped (warning-only) rather than thrown, keeping instrumentation
 * off the turn's critical path.
 */
function snapshotForInstrumentation<T>(value: T, source: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const snapshot: unknown = parseJsonValue(value);
    return snapshot as T;
  } catch (error) {
    log.warn("dropping non-serializable instrumentation snapshot", {
      error: formatError(error),
      source,
    });
    return undefined;
  }
}
