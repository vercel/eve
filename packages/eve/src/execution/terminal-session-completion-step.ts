import { emitTerminalSessionEvent } from "#execution/terminal-session-event.js";
import { createSessionCompletedEvent } from "#protocol/message.js";

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  await emitTerminalSessionEvent({ ...input, event: createSessionCompletedEvent() });
}
