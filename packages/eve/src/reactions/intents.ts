import type { DeliverHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { followUpOf, type FollowUpIntent } from "./follow-up.js";
import type { Reaction } from "./reaction.js";
import { readReactionsState, writeReactionsState, type PendingIntent } from "./state.js";

const log = createLogger("hooks");

// Cancellation targets the running turn, never a later one. A follow-up targets the next turn, for
// the turn that settled. Repeated requests add nothing.

/** A command a hook asked for, before it's queued. */
export type Command =
  | { readonly type: "cancel"; readonly reason?: string }
  | { readonly type: "follow-up"; readonly turnId: string; readonly delivery: DeliverHookPayload };

/**
 * Adds a hook's commands to the session's queue. Cancels between turns are dropped; each hook's
 * follow-up joins the turn's one follow-up delivery.
 */
export function queueCommands(
  ctx: ContextContainer,
  reaction: Pick<Reaction, "id" | "label">,
  occurrence: string,
  commands: readonly Command[],
): void {
  if (commands.length === 0) return;
  const state = readReactionsState(ctx);
  const intents = [...(state.intents ?? [])];
  const turnId = activeTurnIdOf(currentProjection(ctx));
  let changed = false;
  for (const command of commands) {
    if (command.type === "follow-up") {
      // A hook joins the turn's follow-up; `ctx.followUp()` already refused one it can't join.
      const index = intents.findIndex((queued) => queued === followUpOf(intents, command.turnId));
      if (index === -1) intents.push({ ...command, occurrence, reactionId: reaction.id });
      else {
        const queued = intents[index] as FollowUpIntent;
        intents[index] = {
          ...queued,
          delivery: coalesceDeliveries([queued.delivery, command.delivery]),
        };
      }
      changed = true;
      continue;
    }
    if (turnId === undefined || state.cancelledTurnId === turnId) continue;
    if (intents.some((queued) => queued.type === "cancel" && queued.turnId === turnId)) continue;
    intents.push({
      occurrence,
      reactionId: reaction.id,
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
  return failure?.type === "fail" ? failure.reason : undefined;
}
