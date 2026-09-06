import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { Wire } from "#execution/session-inbox/migration.js";
import { downgradeSessionInbox } from "#execution/session-inbox/migrations.js";
import {
  SessionInboxWireError,
  isSessionInboxWireVersion,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";
import { normalizeSessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2-migration.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";
import { sessionInboxWireV5Schema } from "#execution/wire/session-inbox-wire.v5.js";
import { sessionInboxWireV6Schema } from "#execution/wire/session-inbox-wire.v6.js";

const schemas = {
  1: sessionInboxWireV1Schema,
  2: sessionInboxWireV2Schema,
  3: sessionInboxWireV3Schema,
  4: sessionInboxWireV4Schema,
  5: sessionInboxWireV5Schema,
  6: sessionInboxWireV6Schema,
} as const;

type Command = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

function encode<V extends SessionInboxWireVersion>(
  command: Command,
  target: { version: V },
): Wire<V>;
function encode(
  command: Command,
  target: SessionInboxWireTarget,
): Wire<SessionInboxWireVersion> | Record<string, unknown>;
function encode(
  command: Command,
  target: SessionInboxWireTarget,
): Wire<SessionInboxWireVersion> | Record<string, unknown> {
  if (target.version !== 0 && !isSessionInboxWireVersion(target.version)) {
    throw new SessionInboxWireError(`Unknown session inbox wire version ${target.version}.`);
  }
  try {
    const current = sessionInboxWireV6Schema.parse(
      normalizeSessionInboxWireV2(buildCurrentWire(command)),
    );
    if (target.version === 6) return current;
    const version = target.version === 0 ? 1 : target.version;
    const migrated = downgradeSessionInbox(current, version);
    // Validate the exact target representation after every transformation has finished.
    const wire = schemas[version].parse(migrated);
    if (target.version !== 0) return wire;
    const legacy = encodeSessionCommandV0(wire as Wire<1>, target.variant);
    // Older consumers ignore this optional provenance field; it changes no operation.
    if (
      target.variant === "send" &&
      command.kind === "send" &&
      command.delivery?.acceptedDeploymentId !== undefined &&
      legacy.kind === "send"
    ) {
      const delivery = (legacy as Record<string, unknown>).delivery as
        | Record<string, unknown>
        | undefined;
      return {
        ...legacy,
        delivery: { ...delivery, acceptedDeploymentId: command.delivery.acceptedDeploymentId },
      };
    }
    return legacy;
  } catch (error) {
    throw new SessionInboxWireError(
      `Cannot encode session inbox command for wire version ${target.version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildCurrentWire(command: Command): unknown {
  if (command.kind === "send") {
    return {
      auth: command.auth,
      caller: command.caller,
      deliveryMetadata:
        command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
      kind: "deliver",
      payload: command.payload,
      payloads: [command.payload],
      requestId: command.requestId,
      taskDeliveryId: command.taskDeliveryId,
      turnPolicy: command.turnPolicy,
      version: 6,
    };
  }
  if (command.kind === "deliver")
    return { ...command, payload: coalesceDeliverPayloads(command.payloads), version: 6 };
  return { ...command, version: 6 };
}

/** The only production encoder: current command → migration chain → validated target. */
export const sessionInboxWire = { encode } as const;
