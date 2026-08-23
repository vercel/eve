import type { ModelMessage, SystemModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, ParentSessionKey } from "#context/keys.js";
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
  InstrumentationDefinition,
  InstrumentationRuntimeContext,
  InstrumentationStepStartedEventInput,
} from "#public/instrumentation/index.js";
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

const log = createLogger("harness.instrumentation-runtime-context");

export interface BuildTelemetryRuntimeContextInput {
  readonly channel?: {
    readonly kind?: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
  readonly eveVersion: string;
  readonly authored: InstrumentationDefinition | undefined;
  readonly emissionState: HarnessEmissionState;
  readonly environment: string;
  readonly modelInput: {
    readonly instructions: string | SystemModelMessage | undefined;
    readonly messages: readonly ModelMessage[];
  };
  readonly providerResolvers?: readonly RuntimeContextResolver[];
  readonly session: HarnessSession;
}

/**
 * Builds per-model-call runtime context for AI SDK telemetry spans.
 *
 * Authored runtime context is parsed defensively. Invalid event results,
 * reserved `eve.*` keys, and callback failures are warning-only so
 * instrumentation cannot compromise the normal turn flow.
 */
export function buildTelemetryRuntimeContext(
  input: BuildTelemetryRuntimeContextInput,
): Record<string, unknown> | undefined {
  const hasAuthored = input.authored !== undefined;
  const hasProviderResolvers =
    input.providerResolvers !== undefined && input.providerResolvers.length > 0;
  if (!hasAuthored && !hasProviderResolvers) {
    return undefined;
  }

  const authoredRuntimeContext = resolveStepStartedRuntimeContext(input);
  const providerRuntimeContext = resolveProviderRuntimeContext(input);
  return {
    ...authoredRuntimeContext,
    ...providerRuntimeContext,
    "eve.channel.kind": normalizeInstrumentationChannelKind(input.channel?.kind),
    "eve.environment": input.environment,
    "eve.session.id": input.session.sessionId,
    "eve.step.index": String(input.emissionState.stepIndex),
    "eve.turn.id": input.emissionState.turnId,
    "eve.turn.sequence": String(input.emissionState.sequence),
    "eve.version": input.eveVersion,
  };
}

function buildInstrumentationStepStartedInput(
  input: Omit<BuildTelemetryRuntimeContextInput, "authored" | "eveVersion" | "environment">,
): InstrumentationStepStartedEventInput {
  const context = contextStorage.getStore();

  return {
    channel: {
      kind: normalizeInstrumentationChannelKind(input.channel?.kind),
      metadata: snapshotForInstrumentation(input.channel?.metadata, "channel.metadata") ?? {},
    } as InstrumentationChannel,
    modelInput: snapshotForInstrumentation(input.modelInput, "modelInput") ?? {
      instructions: undefined,
      messages: [],
    },
    session: {
      auth: projectSessionAuth(context),
      id: input.session.sessionId,
      parent: snapshotForInstrumentation(context?.get(ParentSessionKey), "session.parent"),
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

function resolveStepStartedRuntimeContext(
  input: BuildTelemetryRuntimeContextInput,
): InstrumentationRuntimeContext | undefined {
  const resolver = input.authored?.events?.["step.started"];
  if (resolver === undefined) {
    return undefined;
  }

  const source = 'events["step.started"]';
  const invoke = () => {
    const stepStartedInput = buildInstrumentationStepStartedInput(input);
    return resolver(stepStartedInput);
  };
  const result = resolveInstrumentationProjection({
    invoke,
    log,
    source,
  });
  if (result === undefined) {
    return undefined;
  }

  if (!("runtimeContext" in result)) {
    log.warn("ignoring instrumentation event result because runtimeContext is missing", { source });
    return undefined;
  }

  let runtimeContext: JsonObject;
  try {
    runtimeContext = parseJsonObject(result.runtimeContext);
  } catch (error) {
    log.warn("ignoring instrumentation event result because runtimeContext is invalid", {
      error: formatError(error),
      source,
    });
    return undefined;
  }

  return filterAuthoredRuntimeContext(runtimeContext, source);
}

/**
 * Collects `runtimeContext` contributions from every provider resolver,
 * invoking each with a snapshot of the same input the legacy `step.started`
 * hook receives. Failures are warning-only so one provider cannot break the
 * turn. Later providers override earlier ones on key collision.
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

function projectSessionAuth(context: AlsContext | undefined): {
  readonly current: SessionAuthContext | null;
  readonly initiator: SessionAuthContext | null;
} {
  const current = context?.get(AuthKey) ?? null;
  const initiator = context?.get(InitiatorAuthKey) ?? current;
  return {
    current: snapshotForInstrumentation(current, "session.auth.current") ?? null,
    initiator: snapshotForInstrumentation(initiator, "session.auth.initiator") ?? null,
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
