import type { DeliverHookPayload, DeliverPayload, SessionCommand } from "#channel/types.js";

/**
 * The durable delivery envelope plus a transitional single-payload mirror.
 *
 * Consumers pinned to eve 0.30.3–0.30.8 cast any non-control inbox payload to
 * a `send` command and read its `payload` field, so the mirror is what keeps
 * their parked sessions receiving messages. Sessions are bounded by the
 * 30-day default timeout; once runs created on those versions have aged out,
 * drop the mirror and return plain `DeliverHookPayload`.
 */
export interface WireDeliverHookPayload extends DeliverHookPayload {
  readonly payload: DeliverPayload;
}

/**
 * Encodes a caller-side `send` command as the durable delivery envelope.
 *
 * `DeliverHookPayload` is the only wire format persisted to session hooks.
 * Hooks outlive deployments, so every producer must emit this envelope and
 * every consumer must keep accepting it; `send` never crosses the durable
 * boundary itself.
 */
export function sendCommandToDelivery(
  command: Extract<SessionCommand, { readonly kind: "send" }>,
): WireDeliverHookPayload {
  return {
    auth: command.auth,
    caller: command.caller,
    idempotencyKey: command.idempotencyKey,
    kind: "deliver",
    payload: command.payload,
    payloads: [command.payload],
    requestId: command.requestId,
  };
}
