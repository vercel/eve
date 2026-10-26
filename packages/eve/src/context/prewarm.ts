import type { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { sandboxPrewarmer } from "#context/providers/sandbox.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("context.prewarm");

/**
 * Why prewarmers run: `"session"` for a session created without a message,
 * before that message; `"turn"` when a turn's step opens its first model call.
 */
export type SessionPrewarmPhase = "session" | "turn";

/**
 * Starts session work in the background so it races the model call instead
 * of delaying it, and whatever needs the result waits only for what remains.
 *
 * `start` runs inside a framework context scope and must return without
 * awaiting the work. It hands the work to a framework provider, which lets a
 * consumer wait for it and settles it before the scope commits. No turn has
 * started in the `"session"` phase: auth is the session creator's, not the
 * first message's.
 *
 * Starting early only moves work earlier. Work that fails is redone when it
 * is needed, as it would have been without prewarming, so it must leave
 * nothing that the lazy path cannot reuse or session end cannot clean up.
 */
export interface SessionPrewarmer {
  /** Names the prewarmer in logs. */
  readonly name: string;
  start(ctx: ContextContainer, phase: SessionPrewarmPhase): void;
}

const sessionPrewarmers: readonly SessionPrewarmer[] = [sandboxPrewarmer];

/** Starts every prewarmer; returns without waiting for their work. */
export function startSessionPrewarmers(ctx: ContextContainer, phase: SessionPrewarmPhase): void {
  for (const prewarmer of sessionPrewarmers) {
    try {
      prewarmer.start(ctx, phase);
    } catch (error) {
      log.warn("session prewarmer failed to start; its work runs when needed", {
        error,
        phase,
        prewarmer: prewarmer.name,
        sessionId: ctx.get(SessionIdKey),
      });
    }
  }
}
