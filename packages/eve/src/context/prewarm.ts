import type { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { sandboxPrewarmer } from "#context/providers/sandbox.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("context.prewarm");

/**
 * Work a session started without a message does before that message arrives.
 *
 * A prewarmer runs in the context scope a turn's steps get, so it reaches
 * session resources through the framework providers, and the durable state
 * those providers own is committed with the prewarm step. No turn has started
 * and no session event is published: the session's auth is its creator's, not
 * the first message's, which may differ.
 *
 * Prewarming only moves work earlier. A prewarmer that fails is logged and
 * skipped, and the first turn does that work lazily as it would have anyway,
 * so a prewarmer must leave nothing behind that the lazy path cannot reuse
 * or session end cannot clean up.
 */
export interface SessionPrewarmer {
  /** Names the prewarmer in logs. */
  readonly name: string;
  prewarm(ctx: ContextContainer): Promise<void>;
}

const sessionPrewarmers: readonly SessionPrewarmer[] = [sandboxPrewarmer];

/** Runs every prewarmer concurrently; must be called inside a framework context scope. */
export async function runSessionPrewarmers(ctx: ContextContainer): Promise<void> {
  const results = await Promise.allSettled(
    sessionPrewarmers.map(async (prewarmer) => await prewarmer.prewarm(ctx)),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    log.warn("session prewarm failed; the first turn does this work instead", {
      error: result.reason,
      prewarmer: sessionPrewarmers[index]?.name,
      sessionId: ctx.get(SessionIdKey),
    });
  });
}
