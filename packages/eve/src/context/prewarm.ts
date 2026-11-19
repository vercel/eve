import type { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { sandboxPrewarmer } from "#context/providers/sandbox.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("context.prewarm");

export type SessionPrewarmPhase = "session" | "turn";

export interface SessionPrewarmer {
  readonly name: string;
  start(ctx: ContextContainer, phase: SessionPrewarmPhase): void;
}

const sessionPrewarmers: readonly SessionPrewarmer[] = [sandboxPrewarmer];

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
