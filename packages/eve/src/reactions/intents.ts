import type { ContextContainer } from "#context/container.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { Reaction } from "./reaction.js";
import { readReactionsState, writeReactionsState, type PendingIntent } from "./state.js";

const log = createLogger("hooks");

// A compact request waits for the next model call, between turns too. Cancellation targets the running turn, never a later one. Repeated requests add nothing.

/** A command a hook asked for, before it's queued. */
export type Command =
  | { readonly type: "cancel"; readonly reason?: string }
  | { readonly type: "compact" };

/**
 * Adds cancellations to the session's queue. Requests between turns are dropped.
 */
export function queueCommands(
  ctx: ContextContainer,
  reactionId: string,
  occurrence: string,
  commands: readonly Command[],
): void {
  if (commands.length === 0) return;
  const state = readReactionsState(ctx);
  const intents = [...(state.intents ?? [])];
  const turnId = activeTurnIdOf(currentProjection(ctx));
  let changed = false;
  for (const command of commands) {
    if (command.type === "compact") {
      // A compaction acts once, whichever turn is next to call the model.
      if (intents.some((queued) => queued.type === "compact")) continue;
      intents.push({ occurrence, reactionId, type: "compact" });
      changed = true;
      continue;
    }
    if (turnId === undefined || state.cancelledTurnId === turnId) continue;
    if (intents.some((queued) => queued.type === "cancel" && queued.turnId === turnId)) continue;
    intents.push({
      occurrence,
      reactionId,
      type: command.type,
      ...(command.reason !== undefined && { reason: command.reason }),
      turnId,
    });
    changed = true;
  }
  if (changed) writeReactionsState(ctx, { ...state, intents });
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

/**
 * A hook, or an effect eve runs after a commit, failed. During a turn, the turn fails at its next
 * boundary: before its next model call, or as it would settle. Between turns, there's no turn to
 * fail, and the failure is logged.
 */
export function reportReactionFailure(
  ctx: ContextContainer,
  reaction: Pick<Reaction, "id" | "kind" | "label">,
  error: unknown,
  occurrence?: string,
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  const message = toErrorMessage(error);
  // Hooks and memory capture run after commits; nothing else reaches here.
  const subject = `${reaction.kind === "memory" ? "Memory" : "Hook"} "${reaction.label}"`;
  log.error(`${subject} failed.`, { error: message, occurrence, turnId });
  if (turnId === undefined) return;
  const state = readReactionsState(ctx);
  const intents = state.intents ?? [];
  if (intents.some((intent) => intent.type === "fail" && intent.turnId === turnId)) return;
  writeReactionsState(ctx, {
    ...state,
    intents: [
      ...intents,
      {
        occurrence: occurrence ?? `fail:${turnId}`,
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

/**
 * Takes the compaction hooks asked for, so the next model call compacts once. Returns the hook
 * that asked first, or undefined when none did.
 */
export function takeCompactRequest(
  ctx: ContextContainer | undefined,
): { readonly hook: string } | undefined {
  if (ctx === undefined) return undefined;
  const [first] = takeIntents(ctx, (intent) => intent.type === "compact");
  return first === undefined ? undefined : { hook: first.reactionId };
}
