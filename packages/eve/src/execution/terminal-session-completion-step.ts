import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import { createSessionCompletedEvent } from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly usage: TokenUsage | undefined;
}): Promise<void> {
  "use step";

  await publishTerminalSessionEvent({
    sessionWritable: input.sessionWritable,
    serializedContext: input.serializedContext,
    event: createSessionCompletedEvent(input.usage),
  });
}
