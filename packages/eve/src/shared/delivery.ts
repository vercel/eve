import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";
import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";

/** Options for one observation, independent of the accepted work and other reads. */
export interface DeliveryReadOptions {
  /** Aborts this read, not the accepted command. Use session.cancel() to cancel work. */
  readonly signal?: AbortSignal;
}

/** An accepted command: its session and delivery ids form a receipt you can pass to `store.follow()`, alongside reusable, independent reads. */
export interface Delivery<TOutput = unknown> {
  readonly sessionId: string;
  readonly deliveryId: string;
  /** Reads the admitting commit through the settlement's complete commit. */
  stream(options?: DeliveryReadOptions): AsyncIterable<SessionStreamEvent>;
  /** Waits for this delivery's settlement, not the end of its session. */
  result(options?: DeliveryReadOptions): Promise<DeliveryResult<TOutput>>;
}

/** A settled request. Human input finishes this delivery; its answer is a new delivery. */
export type DeliveryResult<TOutput = unknown> = {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly outcome: DeliveryOutcome;
  /** Whether the session ended in the response's final commit. */
  readonly sessionEnded: boolean;
  /** The reply's text, when the request produced one. */
  readonly reply: string | undefined;
  /** Structured output inferred from the supplied Standard Schema, when available. */
  readonly data: TOutput | undefined;
  readonly interactions: readonly Interaction[];
} & (
  | { readonly status: Exclude<RequestStatus, "failed">; readonly error?: never }
  | { readonly status: "failed"; readonly error: ErrorInfo }
);
