import type { HarnessTurnRef } from "#harness/emission-state.js";
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import { createSessionCompletedEvent } from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  /** The session's last turn, reported to channel handlers as `ctx.session.turn`. */
  readonly turn?: HarnessTurnRef;
  readonly usage: TokenUsage | undefined;
}): Promise<void> {
  "use step";

  await publishTerminalSessionEvent({
    sessionWritable: input.sessionWritable,
    serializedContext: input.serializedContext,
    turn: input.turn,
    event: createSessionCompletedEvent(input.usage),
  });
}
