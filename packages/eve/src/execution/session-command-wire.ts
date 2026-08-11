import type { DeliverHookPayload, DeliverPayload, SessionCommand } from "#channel/types.js";

const ADAPTER_STATE_PAYLOAD_FIELD = "$eve.adapterState";

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
  const payload =
    command.adapterState === undefined
      ? command.payload
      : { ...command.payload, [ADAPTER_STATE_PAYLOAD_FIELD]: command.adapterState };
  return {
    auth: command.auth,
    caller: command.caller,
    kind: "deliver",
    payload,
    payloads: [payload],
    requestId: command.requestId,
  };
}

/**
 * Removes framework-owned channel state from delivery payloads before adapters
 * observe them. Keeping this metadata inside the established payload envelope
 * lets deployment-pinned session drivers preserve it across upgrades.
 */
export function extractAdapterStateFromPayloads(payloads: readonly DeliverPayload[]): {
  readonly adapterState?: Readonly<Record<string, unknown>>;
  readonly payloads: readonly DeliverPayload[];
} {
  let adapterState: Readonly<Record<string, unknown>> | undefined;
  let changed = false;
  const sanitized = payloads.map((payload) => {
    if (!Object.hasOwn(payload, ADAPTER_STATE_PAYLOAD_FIELD)) return payload;
    changed = true;
    const { [ADAPTER_STATE_PAYLOAD_FIELD]: candidate, ...rest } = payload;
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      adapterState = candidate as Readonly<Record<string, unknown>>;
    }
    return rest;
  });

  return {
    ...(adapterState === undefined ? {} : { adapterState }),
    payloads: changed ? sanitized : payloads,
  };
}
