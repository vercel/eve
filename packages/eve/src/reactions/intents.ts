import type { ContextContainer } from "#context/container.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { createLogger } from "#internal/logging.js";
import { INTENT_KIND, type HookIntent } from "#public/definitions/hook.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import type { Reaction } from "./reaction.js";
import { readReactionsState, writeReactionsState, type PendingIntent } from "./state.js";

const log = createLogger("hooks");

// Intents are what a reaction asks the session to do, such as compact or cancel. Unlike the
// capabilities a reaction holds while its selection stands, an intent acts once for the
// occurrence that returned it: a new selection, or a fact an events handler received. The
// session acts on the queue below, and re-rendering an occurrence queues nothing new.

/** One occurrence and what a reaction returned for it. */
export interface Occurrence {
  readonly occurrence: string;
  readonly result: unknown;
}

/**
 * Records the intents each occurrence returned, once per occurrence and type, and returns the
 * occurrences that asked for something. A cancel targets the turn running now, and is dropped
 * when none is.
 */
export function queueIntents(
  ctx: ContextContainer,
  reactionId: string,
  label: string,
  occurrences: readonly Occurrence[],
): JsonValue {
  const state = readReactionsState(ctx);
  const intents = [...(state.intents ?? [])];
  const asked: string[] = [];
  const turnId = activeTurnIdOf(currentProjection(ctx));
  for (const { occurrence, result } of occurrences) {
    for (const intent of intentsOf(result, label)) {
      if (intent.type === "cancel" && turnId === undefined) continue;
      if (
        intents.some((queued) => queued.occurrence === occurrence && queued.type === intent.type)
      ) {
        continue;
      }
      intents.push({
        occurrence,
        reactionId,
        type: intent.type,
        ...(intent.reason !== undefined && { reason: intent.reason }),
        ...(intent.type === "cancel" && { turnId }),
      });
      if (!asked.includes(occurrence)) asked.push(occurrence);
    }
  }
  if (asked.length > 0) writeReactionsState(ctx, { ...state, intents });
  return asked.length === 0 ? null : asked;
}

/** The intents in a hook's result: one, several, or a map of them, whose names don't matter. */
function intentsOf(result: unknown, label: string): readonly HookIntent[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result.flatMap((entry) => intentsOf(entry, label));
  if (typeof result !== "object") throw notAnIntent(label);
  if ((result as Partial<HookIntent>).kind === INTENT_KIND) return [result as HookIntent];
  return Object.values(result).flatMap((entry) => {
    if (entry === null || entry === undefined) return [];
    if ((entry as Partial<HookIntent>).kind !== INTENT_KIND) throw notAnIntent(label);
    return [entry as HookIntent];
  });
}

function notAnIntent(label: string): Error {
  return new Error(
    `Hook "${label}" returned something other than intents. Return cancel(), compact(), several of them, or nothing.`,
  );
}

/** Removes and returns the waiting intents that match, because the session acted on them. */
export function takeIntents(
  ctx: ContextContainer,
  matches: (intent: PendingIntent) => boolean,
): readonly PendingIntent[] {
  const state = readReactionsState(ctx);
  const taken = (state.intents ?? []).filter(matches);
  if (taken.length === 0) return taken;
  const intents = (state.intents ?? []).filter((intent) => !matches(intent));
  writeReactionsState(ctx, { ...state, intents });
  return taken;
}

/** True while a hook's compact intent waits for a compaction to start. */
export function hasPendingCompaction(ctx: Pick<ContextContainer, "get"> | undefined): boolean {
  return (readReactionsState(ctx).intents ?? []).some((intent) => intent.type === "compact");
}

/**
 * A hook, or an effect eve runs after a commit, failed. During a turn, the turn fails at its next
 * boundary: before its next model call, or as it would settle. Between turns, there's no turn to
 * fail, and the failure is logged.
 */
export function reportReactionFailure(
  ctx: ContextContainer,
  reaction: Pick<Reaction, "id" | "kind" | "label">,
  error: unknown,
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  const message = toErrorMessage(error);
  // Hooks and memory capture run after commits; nothing else reaches here.
  const subject = `${reaction.kind === "memory" ? "Memory" : "Hook"} "${reaction.label}"`;
  log.error(`${subject} failed.`, { error: message, turnId });
  if (turnId === undefined) return;
  const state = readReactionsState(ctx);
  const intents = state.intents ?? [];
  if (intents.some((intent) => intent.type === "fail" && intent.turnId === turnId)) return;
  writeReactionsState(ctx, {
    ...state,
    intents: [
      ...intents,
      {
        occurrence: `fail:${turnId}`,
        reactionId: reaction.id,
        reason: `${subject} failed: ${message}`,
        turnId,
        type: "fail",
      },
    ],
  });
}

/** Takes the failure a hook reported for the running turn, if any. */
export function takeTurnFailure(ctx: ContextContainer | undefined): string | undefined {
  if (ctx === undefined) return undefined;
  const turnId = activeTurnIdOf(currentProjection(ctx));
  if (turnId === undefined) return undefined;
  const [failure] = takeIntents(
    ctx,
    (intent) => intent.type === "fail" && intent.turnId === turnId,
  );
  return failure?.reason;
}
