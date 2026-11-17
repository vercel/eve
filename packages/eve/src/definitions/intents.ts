import type { DeliverHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { readDefinitionsState, writeDefinitionsState, type PendingIntent } from "./state.js";

const log = createLogger("hooks");

export type Command =
  | { readonly type: "cancel"; readonly reason?: string }
  | { readonly type: "continue"; readonly turnId: string; readonly delivery: DeliverHookPayload };

export function queueCommands(
  ctx: ContextContainer,
  definition: { readonly id: string; readonly label: string },
  occurrence: string,
  commands: readonly Command[],
): void {
  if (commands.length === 0) return;
  const state = readDefinitionsState(ctx);
  const intents = [...(state.intents ?? [])];
  let { continuation } = state;
  const turnId = activeTurnIdOf(currentProjection(ctx));
  let changed = false;
  for (const command of commands) {
    if (command.type === "continue") {
      const queued = continuation?.turnId === command.turnId ? continuation : undefined;
      continuation = {
        delivery:
          queued === undefined
            ? command.delivery
            : coalesceDeliveries([queued.delivery, command.delivery]),
        turnId: command.turnId,
      };
      changed = true;
      continue;
    }
    if (turnId === undefined || state.cancelledTurnId === turnId) continue;
    if (intents.some((queued) => queued.type === "cancel" && queued.turnId === turnId)) continue;
    intents.push({
      occurrence,
      reactionId: definition.id,
      type: command.type,
      ...(command.reason !== undefined && { reason: command.reason }),
      turnId,
    });
    changed = true;
  }
  if (changed) {
    writeDefinitionsState(ctx, {
      ...state,
      intents,
      ...(continuation !== undefined && { continuation }),
    });
  }
}

export function takeIntents(
  ctx: ContextContainer,
  matches: (intent: PendingIntent) => boolean,
): readonly PendingIntent[] {
  const state = readDefinitionsState(ctx);
  const taken = (state.intents ?? []).filter(matches);
  if (taken.length === 0) return taken;
  const intents = (state.intents ?? []).filter((intent) => !matches(intent));
  writeDefinitionsState(ctx, { ...state, intents });
  return taken;
}

export function reportEffectFailure(
  ctx: ContextContainer,
  definition: { readonly id: string; readonly label: string },
  error: unknown,
  occurrence?: string,
): void {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  const message = toErrorMessage(error);
  const subject = `${definition.id.startsWith("memory:") ? "Memory" : "Hook"} "${definition.label}"`;
  log.error(`${subject} failed.`, { error: message, occurrence, turnId });
  if (turnId === undefined) return;
  const state = readDefinitionsState(ctx);
  const intents = state.intents ?? [];
  if (intents.some((intent) => intent.type === "fail" && intent.turnId === turnId)) return;
  writeDefinitionsState(ctx, {
    ...state,
    intents: [
      ...intents,
      {
        occurrence: occurrence ?? `fail:${turnId}`,
        reactionId: definition.id,
        reason: `${subject} failed: ${message}`,
        turnId,
        type: "fail",
      },
    ],
  });
}

export function takeTurnFailure(ctx: ContextContainer): string | undefined {
  const turnId = activeTurnIdOf(currentProjection(ctx));
  if (turnId === undefined) return undefined;
  const [failure] = takeIntents(
    ctx,
    (intent) => intent.type === "fail" && intent.turnId === turnId,
  );
  return failure?.reason;
}
