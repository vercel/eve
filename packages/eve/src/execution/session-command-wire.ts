import type { DeliverHookPayload, SessionCommand } from "#channel/types.js";

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
): DeliverHookPayload {
  return {
    auth: command.auth,
    caller: command.caller,
    kind: "deliver",
    payloads: [command.payload],
    requestId: command.requestId,
  };
}
