type HarnessTurnRef = { readonly id: string; readonly sequence: number };
import type { ControlDelivery } from "#harness/types.js";
import type { ControlSettlement } from "#harness/facts.js";
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

/** Emits a terminal `session.ended` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  /** The session's last turn, reported to channel handlers as `ctx.session.turn`. */
  readonly turn?: HarnessTurnRef;
  readonly usage: TokenUsage | undefined;
  /** The session's last checkpointed projection. */
  readonly projection?: SessionProjection;
  readonly sessionState?: DurableSessionState;
  /** The reset control that ends the session, when it named its delivery. */
  readonly control?: ControlDelivery;
  readonly settles?: readonly ControlSettlement[];
}): Promise<void> {
  "use step";

  const { control, settles, ...rest } = input;
  await publishTerminalSessionEvent({
    ...rest,
    ending: { control, settles, outcome: "completed" },
  });
}
