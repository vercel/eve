import type { ModelMessage } from "ai";

import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  TurnDynamicModelReferenceKey,
  type LiveDynamicModelSelection,
} from "#context/keys.js";
import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type {
  RuntimeDynamicModelReference,
  RuntimeModelReference,
} from "#runtime/agent/bootstrap.js";
import {
  loadDynamicRuntimeModelDefinition,
  normalizeDynamicRuntimeModelResult,
  shouldMockAuthoredRuntimeModels,
  type ResolvedRuntimeModelSelection,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import { toErrorMessage } from "#shared/errors.js";
import type { DynamicToolEventName } from "#shared/dynamic-tool-definition.js";

const log = createLogger("dynamic-models");

const ALLOWED_DYNAMIC_MODEL_EVENTS = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
  "step.started",
]);

export type ActiveDynamicModelSelection = LiveDynamicModelSelection;

function isDynamicModelEventName(value: string): value is DynamicToolEventName {
  return ALLOWED_DYNAMIC_MODEL_EVENTS.has(value as DynamicToolEventName);
}

function durableKeyForEvent(
  eventType: DynamicToolEventName,
): ContextKey<RuntimeModelReference | null> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicModelReferenceKey;
    case "turn.started":
      return TurnDynamicModelReferenceKey;
    case "step.started":
      return undefined;
  }
}

export function getActiveDynamicModelSelection(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): ActiveDynamicModelSelection | null {
  const step = ctx.get(LiveStepDynamicModelSelectionKey);
  if (step !== undefined && step !== null) {
    return step;
  }

  const turn = ctx.get(TurnDynamicModelReferenceKey);
  if (turn !== undefined && turn !== null) {
    return { reference: turn };
  }

  const session = ctx.get(SessionDynamicModelReferenceKey);
  if (session !== undefined && session !== null) {
    return { reference: session };
  }

  return null;
}

export async function dispatchDynamicModelEvent(input: {
  readonly ctx: AlsContext;
  readonly dynamicModel: RuntimeDynamicModelReference | undefined;
  readonly event: HandleMessageStreamEvent;
  readonly fallback: RuntimeModelReference;
  readonly messages: readonly ModelMessage[];
  readonly scope: RuntimeModelResolutionScope;
}): Promise<void> {
  if (input.dynamicModel === undefined) return;
  if (!isDynamicModelEventName(input.event.type)) return;
  if (!input.dynamicModel.eventNames.includes(input.event.type)) return;

  try {
    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: input.dynamicModel,
      scope: input.scope,
    });
    const handler = definition.events[input.event.type];

    if (handler === undefined) {
      setSelectionForEvent(input.ctx, input.event.type, null);
      return;
    }

    const rawResult = await handler(input.event, buildResolveContext(input.ctx, input.messages));
    const selection =
      rawResult === null || rawResult === undefined
        ? null
        : normalizeDynamicRuntimeModelResult({
            fallback: input.fallback,
            result: rawResult,
          });

    if (
      selection !== null &&
      input.event.type !== "step.started" &&
      selection.model !== undefined
    ) {
      log.error(
        `Dynamic model resolver (${input.event.type}) returned a provider object, but session- and turn-scoped model selections must be serializable. Return a model id string for this scope, or use "step.started".`,
      );
      setSelectionForEvent(input.ctx, input.event.type, null);
      return;
    }

    setSelectionForEvent(input.ctx, input.event.type, selection);
  } catch (error) {
    log.error(`Dynamic model resolver (${input.event.type}) threw - skipping.`, {
      error: toErrorMessage(error),
    });
    setSelectionForEvent(input.ctx, input.event.type, null);
  }
}

function setSelectionForEvent(
  ctx: AlsContext,
  eventType: DynamicToolEventName,
  selection: ResolvedRuntimeModelSelection | null,
): void {
  if (eventType === "step.started") {
    // In mock mode drop the live instance so the mock adapter keeps precedence.
    const stored =
      selection !== null && selection.model !== undefined && shouldMockAuthoredRuntimeModels()
        ? { reference: selection.reference }
        : selection;
    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, stored);
    return;
  }

  const durableKey = durableKeyForEvent(eventType);
  if (durableKey === undefined) return;
  ctx.set(durableKey, selection?.reference ?? null);
}
