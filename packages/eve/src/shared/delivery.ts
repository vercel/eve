import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { Interaction } from "#protocol/session-reader.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";

/** An accepted command: a serializable receipt and a stream through its own settlement. */
export interface Delivery<TOutput = unknown> extends AsyncIterable<SessionStreamEvent> {
  readonly sessionId: string;
  readonly deliveryId: string;
  /** Reads this delivery's settlement, independently of whether its session remains open. */
  result(): Promise<DeliveryResult<TOutput>>;
}

/** What happened to one accepted request. */
export interface DeliveryResult<TOutput = unknown> {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly status: RequestStatus;
  /** Whether the session ended in the response's final commit. */
  readonly sessionEnded: boolean;
  /** The reply's text, when the request produced one. */
  readonly reply: string | undefined;
  /** Structured output inferred from the supplied Standard Schema, when available. */
  readonly data: TOutput | undefined;
  readonly events: SessionStreamEvent[];
  readonly interactions: readonly Interaction[];
}
