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
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
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
import type { DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import { toErrorMessage } from "#shared/errors.js";

const ALLOWED_DYNAMIC_MODEL_EVENTS = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
  "step.started",
]);

export type ActiveDynamicModelSelection = LiveDynamicModelSelection;

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
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly scope: RuntimeModelResolutionScope;
}): Promise<void> {
  if (input.dynamicModel === undefined) return;
  if (!isDynamicModelEventName(input.event.type)) return;
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

    const rawResult = await handler(input.event, buildResolveContext(input.ctx, input.messages));
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
