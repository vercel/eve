type HarnessTurnRef = { readonly id: string; readonly sequence: number };
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { sessionCompleted } from "#harness/session-machine/transitions.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  /** The session's last turn, reported to channel handlers as `ctx.session.turn`. */
  readonly turn?: HarnessTurnRef;
  readonly usage: TokenUsage | undefined;
  /** The position of the line the event takes. */
  readonly position?: number;
}): Promise<void> {
  "use step";

  await publishTerminalSessionEvent({ ...input, event: sessionCompleted(input.usage) });
}
