import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { sessionCompleted } from "#harness/session-machine/transitions.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly usage: TokenUsage | undefined;
}): Promise<void> {
  "use step";

  await publishTerminalSessionEvent({ ...input, event: sessionCompleted(input.usage) });
}
