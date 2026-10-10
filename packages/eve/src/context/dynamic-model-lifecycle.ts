import type { ModelMessage } from "ai";

import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import { isMockModel } from "#internal/mock-model-identity.js";
import {
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  TurnDynamicModelReferenceKey,
} from "#context/keys.js";
import type {
  RuntimeDynamicModelReference,
  RuntimeModelReference,
} from "#runtime/agent/bootstrap.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelSelection,
  shouldMockAuthoredRuntimeModels,
  type ResolvedRuntimeModelSelection,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { DynamicScopeEvent, DynamicToolEventName } from "#dynamic/definition.js";
import { toErrorMessage } from "#shared/errors.js";

const DYNAMIC_MODEL_SELECTION_ERROR_CODE = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";

export class DynamicModelSelectionError extends Error {
  readonly code = DYNAMIC_MODEL_SELECTION_ERROR_CODE;
  override readonly name = "DynamicModelSelectionError";

  constructor(error: unknown) {
    super(toErrorMessage(error), { cause: error });
  }
}

export function isDynamicModelSelectionError(error: unknown): error is DynamicModelSelectionError {
  return (
    error instanceof DynamicModelSelectionError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === DYNAMIC_MODEL_SELECTION_ERROR_CODE)
  );
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

/** Runs the dynamic model resolver for a session, a turn, or one model call. */
export async function resolveDynamicModel(input: {
  readonly abortSignal?: AbortSignal;
  readonly ctx: AlsContext;
  readonly dynamicModel: RuntimeDynamicModelReference | undefined;
  readonly event: DynamicScopeEvent;
  readonly messages: readonly ModelMessage[];
  readonly scope: RuntimeModelResolutionScope;
}): Promise<void> {
  if (input.dynamicModel === undefined) return;
  if (!input.dynamicModel.eventNames.includes(input.event.type)) return;

  setSelectionForEvent(input.ctx, input.event.type, null);
  try {
    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: input.dynamicModel,
      scope: input.scope,
    });
    const handler = definition.events[input.event.type];

    if (handler === undefined) {
      throw new Error(
        `Dynamic model resolver is missing its compiled "${input.event.type}" handler.`,
      );
    }

    input.abortSignal?.throwIfAborted();
    const rawResult = await handler(input.event.fact, {
      ...buildResolveContext(input.ctx, input.messages),
      abortSignal: input.abortSignal,
    });
    input.abortSignal?.throwIfAborted();
    const selection = await resolveRuntimeModelSelection({
      durability: input.event.type === "step.started" ? "live" : "durable",
      selection: rawResult as never,
      state: input.ctx,
    });

    setSelectionForEvent(input.ctx, input.event.type, selection);
  } catch (error) {
    throw isDynamicModelSelectionError(error) ? error : new DynamicModelSelectionError(error);
  }
}

function setSelectionForEvent(
  ctx: AlsContext,
  eventType: DynamicToolEventName,
  selection: ResolvedRuntimeModelSelection | null,
): void {
  if (eventType === "step.started") {
    // Replace real providers in mock mode, but keep explicitly scripted responders.
    const stored =
      selection !== null &&
      selection.model !== undefined &&
      !isMockModel(selection.model) &&
      shouldMockAuthoredRuntimeModels()
        ? { reference: selection.reference }
        : selection;
    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, stored);
    return;
  }

  const durableKey = durableKeyForEvent(eventType);
  if (durableKey === undefined) return;
  ctx.set(durableKey, selection?.reference ?? null);
}
