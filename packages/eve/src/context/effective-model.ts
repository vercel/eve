import type { ContextKey } from "#context/key.js";
import {
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  StaticModelReferenceKey,
  TurnDynamicModelReferenceKey,
  type LiveDynamicModelSelection,
} from "#context/keys.js";

export function getEffectiveModelSelection(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): LiveDynamicModelSelection | null {
  const step = ctx.get(LiveStepDynamicModelSelectionKey);
  if (step !== undefined && step !== null) return step;

  const turn = ctx.get(TurnDynamicModelReferenceKey);
  if (turn !== undefined && turn !== null) return { reference: turn };

  const session = ctx.get(SessionDynamicModelReferenceKey);
  if (session !== undefined && session !== null) return { reference: session };

  const staticModel = ctx.get(StaticModelReferenceKey);
  if (staticModel === undefined) {
    throw new Error("Effective model resolution requires initialized static model state.");
  }
  return staticModel === null ? null : { reference: staticModel };
}
