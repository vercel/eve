import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { Wire } from "#execution/wire/session-inbox/migration.js";
import { downgradeSessionInbox } from "#execution/wire/session-inbox/migrations.js";
import {
  SessionInboxWireError,
  SessionInboxIncompatibleError,
  isSessionInboxWireVersion,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";
import { normalizeSessionInboxWire } from "#execution/wire/session-inbox-normalize.js";
import { schemas, currentSchema } from "#execution/wire/session-inbox/generated/schemas.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";

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
    const current = currentSchema.parse(normalizeSessionInboxWire(buildCurrentWire(command)));
    if (target.version === SESSION_INBOX_WIRE_VERSION) return current;
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
    const message = `Cannot encode session inbox command for wire version ${target.version}: ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof SessionInboxIncompatibleError)
      throw new SessionInboxIncompatibleError(message);
    throw new SessionInboxWireError(message);
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
      version: SESSION_INBOX_WIRE_VERSION,
    };
  }
  if (command.kind === "deliver")
    return {
      ...command,
      payload: coalesceDeliverPayloads(command.payloads),
      version: SESSION_INBOX_WIRE_VERSION,
    };
  return { ...command, version: SESSION_INBOX_WIRE_VERSION };
}

/** The only production encoder: current command → migration chain → validated target. */
export const sessionInboxWire = { encode } as const;
