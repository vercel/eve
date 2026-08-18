import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import type { SessionInboxWireV1 } from "#execution/wire/session-inbox-wire.v1.js";
import { isObject } from "#shared/guards.js";

/**
 * Version 0 is the unversioned era. Its sole shape change is the raw `send`
 * command persisted by eve 0.30.5–0.30.8; legacy `deliver` already has the
 * v1 discriminator and needs only the version stamp.
 *
 * This module is removable once runs created by that cohort have aged out
 * under the 30-day default session timeout.
 */
function migrateSessionInboxWireV0(
  prior: unknown,
): Record<string, unknown> & { readonly version: 1 } {
  const value = prior as Record<string, unknown>;
  if (value.kind === "send") return migrateLegacySend(value);

  if (
    value.kind === "deliver" &&
    !(Array.isArray(value.payloads) && value.payloads.every(isObject))
  ) {
    throw new Error("legacy deliver payload has no object-array payloads field.");
  }

  return { ...value, version: 1 };
}

function migrateLegacySend(
  send: Record<string, unknown>,
): Record<string, unknown> & { readonly version: 1 } {
  if (!isObject(send.payload)) {
    throw new Error("legacy send command has no object payload field.");
  }
  if (send.delivery !== undefined && !isObject(send.delivery)) {
    throw new Error("legacy send command has a non-object delivery field.");
  }

  return {
    auth: send.auth,
    caller: send.caller,
    deliveryMetadata:
      send.delivery === undefined ? undefined : [{ ...send.delivery, payloadIndex: 0 }],
    kind: "deliver",
    payload: send.payload,
    payloads: [send.payload],
    requestId: send.requestId,
    taskDeliveryId: send.taskDeliveryId,
    turnPolicy: send.turnPolicy,
    version: 1,
  };
}

export const sessionInboxWireV0Migration: VersionMigration = {
  from: 0,
  migrate: migrateSessionInboxWireV0,
  to: 1,
};

/** Encodes the two incompatible shapes from the unversioned wire era. */
export function encodeSessionCommandV0(
  wire: SessionInboxWireV1,
  variant: "deliver" | "send",
): Omit<SessionInboxWireV1, "version"> | Record<string, unknown> {
  if (wire.kind !== "deliver") {
    const { version: _version, ...legacy } = wire;
    return legacy;
  }

  if (variant === "deliver") {
    const { payload: _payload, version: _version, ...legacy } = wire;
    return legacy;
  }

  const deliveryMetadata = wire.deliveryMetadata?.find((metadata) => metadata.payloadIndex === 0);
  let delivery: Omit<NonNullable<typeof deliveryMetadata>, "payloadIndex"> | undefined;
  if (deliveryMetadata !== undefined) {
    const { payloadIndex: _payloadIndex, ...value } = deliveryMetadata;
    delivery = value;
  }
  return {
    auth: wire.auth,
    caller: wire.caller,
    delivery,
    kind: "send",
    payload: wire.payload,
    requestId: wire.requestId,
    taskDeliveryId: wire.taskDeliveryId,
    turnPolicy: wire.turnPolicy,
  };
}
