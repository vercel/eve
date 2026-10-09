type HarnessTurnRef = { readonly id: string; readonly sequence: number };
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { SessionProjection } from "#protocol/session-projection.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  /** The session's last turn, reported to channel handlers as `ctx.session.turn`. */
  readonly turn?: HarnessTurnRef;
  readonly usage: TokenUsage | undefined;
  /** The session's last checkpointed projection. */
  readonly projection?: SessionProjection;
}): Promise<void> {
  "use step";

  await publishTerminalSessionEvent({ ...input, ending: { outcome: "completed" } });
}
