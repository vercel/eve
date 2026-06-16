declare const receiveTargetMarker: unique symbol;

/**
 * Structural marker that channel factories (e.g. `slackChannel`,
 * `twilioChannel`) add to declare the target type their `receive()` accepts.
 * `receive(channel, { target })` helpers and the route-handler
 * `args.receive(channel, ...)` read this marker to infer typed targets
 * from a plain channel import.
 */
export interface TypedReceiveTarget<TTarget = Record<string, unknown>> {
  readonly [receiveTargetMarker]?: TTarget;
}

/**
 * Extracts the receive-target type from a channel value, falling back to
 * `Record<string, unknown>` when the channel declares no marker.
 */
export type InferReceiveTarget<TChannel> =
  TChannel extends TypedReceiveTarget<infer TTarget> ? TTarget : Record<string, unknown>;
