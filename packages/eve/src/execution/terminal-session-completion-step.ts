import type { Cause } from "#protocol/session-events/envelope.js";
type HarnessTurnRef = { readonly id: string; readonly sequence: number };
import type { ControlDelivery } from "#harness/types.js";
import type { ControlSettlement } from "#harness/facts.js";
import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

export async function emitTerminalSessionCompletionStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly turn?: HarnessTurnRef;
  readonly usage: TokenUsage | undefined;
  readonly projection?: SessionProjection;
  readonly sessionState?: DurableSessionState;
  readonly cause?: Cause;
  readonly control?: ControlDelivery;
  readonly settles?: readonly ControlSettlement[];
}): Promise<void> {
  "use step";

  const { cause, control, settles, ...rest } = input;
  await publishTerminalSessionEvent({
    ...rest,
    ending: { cause, control, settles, outcome: "completed" },
  });
}
