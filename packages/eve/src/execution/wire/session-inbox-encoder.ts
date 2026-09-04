import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  encodeSessionCommandV1,
  type SessionInboxWireV1,
} from "#execution/wire/session-inbox-wire.v1.js";
import {
  encodeSessionCommandV2,
  type SessionInboxWireV2,
} from "#execution/wire/session-inbox-wire.v2.js";
import {
  encodeSessionCommandV3,
  type SessionInboxWireV3,
} from "#execution/wire/session-inbox-wire.v3.js";
import {
  SESSION_INBOX_WIRE_VERSION,
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";
import {
  encodeSessionCommandV4,
  type SessionInboxWireV4,
} from "#execution/wire/session-inbox-wire.v4.js";
import {
  encodeSessionCommandV5,
  type SessionInboxWireV5,
} from "#execution/wire/session-inbox-wire.v5.js";
import {
  encodeSessionCommandV6,
  type SessionInboxWireV6,
} from "#execution/wire/session-inbox-wire.v6.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV6;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;
type VersionedSessionInboxEncoder = (command: SessionInboxCommand) => unknown;

const versionedEncoders = {
  1: (command: SessionInboxCommand) =>
    encodeSessionCommandV1(withoutAcceptedDeployment(withoutOwnedTaskCancellation(command))),
  2: (command: SessionInboxCommand) =>
    encodeSessionCommandV2(withoutAcceptedDeployment(withoutOwnedTaskCancellation(command))),
  3: (command: SessionInboxCommand) =>
    encodeSessionCommandV3(withoutOwnedTaskCancellation(command)),
  4: (command: SessionInboxCommand) =>
    encodeSessionCommandV4(withoutOwnedTaskCancellation(command)),
  5: (command: SessionInboxCommand) =>
    encodeSessionCommandV5(withoutOwnedTaskCancellation(command)),
  6: encodeSessionCommandV6,
} satisfies Record<SessionInboxWireVersion, VersionedSessionInboxEncoder>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
function encode(command: SessionInboxCommand, target: { readonly version: 2 }): SessionInboxWireV2;
function encode(command: SessionInboxCommand, target: { readonly version: 3 }): SessionInboxWireV3;
function encode(command: SessionInboxCommand, target: { readonly version: 4 }): SessionInboxWireV4;
function encode(command: SessionInboxCommand, target: { readonly version: 5 }): SessionInboxWireV5;
function encode(command: SessionInboxCommand, target: { readonly version: 6 }): SessionInboxWireV6;
function encode(
  command: SessionInboxCommand,
  target: { readonly version: SessionInboxWireVersion },
): unknown;
function encode(
  command: SessionInboxCommand,
  target: LegacySessionInboxWireTarget,
): Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
):
  | SessionInboxWireV1
  | SessionInboxWireV2
  | SessionInboxWireV3
  | SessionInboxWireV4
  | SessionInboxWireV5
  | SessionInboxWireV6
  | Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
):
  | SessionInboxWireV1
  | SessionInboxWireV2
  | SessionInboxWireV3
  | SessionInboxWireV4
  | SessionInboxWireV5
  | SessionInboxWireV6
  | Record<string, unknown> {
  if (command.kind === "cancel" && command.tasks === true && target.version < 6) {
    throw new SessionInboxWireError(
      `Cannot encode session-owned task cancellation for wire version ${target.version}.`,
    );
  }
  if (target.version === 0) {
    const currentTaskWire =
      target.variant === "send" && command.kind === "send" && command.payload.task !== undefined
        ? encodeSessionCommandV5(command)
        : undefined;
    let legacy = encodeSessionCommandV0(
      encodeSessionCommandV1(
        withoutCurrentTaskMessages(
          withoutAcceptedDeployment(withoutOwnedTaskCancellation(command)),
        ),
      ),
      target.variant,
    );
    if (currentTaskWire?.kind === "deliver") {
      legacy = { ...legacy, payload: currentTaskWire.payload };
    }
    const legacyRecord = legacy as Record<string, unknown>;
    const delivery = legacyRecord.delivery;
    const acceptedDeploymentId = readAcceptedDeploymentId(command);
    if (
      target.variant !== "send" ||
      acceptedDeploymentId === undefined ||
      legacyRecord.kind !== "send" ||
      typeof delivery !== "object" ||
      delivery === null
    ) {
      return legacy;
    }
    return {
      ...legacy,
      delivery: { ...(delivery as Record<string, unknown>), acceptedDeploymentId },
    };
  }
  if (isSessionInboxWireVersion(target.version)) {
    return versionedEncoders[target.version](command) as
      | SessionInboxWireV1
      | SessionInboxWireV2
      | SessionInboxWireV3
      | SessionInboxWireV4
      | SessionInboxWireV5
      | SessionInboxWireV6;
  }
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
}

function withoutOwnedTaskCancellation(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind !== "cancel" || command.tasks === undefined) return command;
  const { tasks: _tasks, ...legacy } = command;
  return legacy;
}

function withoutCurrentTaskMessages(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind !== "send" || command.payload.task === undefined) return command;
  const {
    agentRequests: _agentRequests,
    inputRequests: _inputRequests,
    ...task
  } = command.payload.task;
  return { ...command, payload: { ...command.payload, task } };
}

function withoutAcceptedDeployment(command: SessionInboxCommand): SessionInboxCommand {
  if (command.kind === "send" && command.delivery?.acceptedDeploymentId !== undefined) {
    const { acceptedDeploymentId: _acceptedDeploymentId, ...delivery } = command.delivery;
    return { ...command, delivery };
  }
  if (command.kind !== "deliver" || command.deliveryMetadata === undefined) return command;
  return {
    ...command,
    deliveryMetadata: command.deliveryMetadata.map((metadata) => {
      const { acceptedDeploymentId: _acceptedDeploymentId, ...legacy } = metadata;
      return legacy;
    }),
  };
}

function readAcceptedDeploymentId(command: SessionInboxCommand): string | undefined {
  if (command.kind === "send") return command.delivery?.acceptedDeploymentId;
  if (command.kind !== "deliver") return undefined;
  return command.deliveryMetadata?.find((metadata) => metadata.payloadIndex === 0)
    ?.acceptedDeploymentId;
}
/**
 * Validates current contents without tying a delivery to the sender's release.
 * Every shipped inbox decoder accepts an unversioned envelope. Only the
 * pre-stamp active-turn receiver requires the historical `send` discriminator.
 */
function encodeCompatible(
  command: SessionInboxCommand,
  variant: "deliver" | "send",
): Record<string, unknown> {
  if (command.kind === "cancel" && command.tasks === true) {
    throw new SessionInboxWireError("Session-owned task cancellation requires a capable parent.");
  }
  const wire = encode(command, { version: SESSION_INBOX_WIRE_VERSION }) as SessionInboxWire;
  const { version: _version, ...envelope } = wire;
  if (wire.kind !== "deliver" || variant === "deliver") return envelope;
  const deliveryMetadata = wire.deliveryMetadata?.find((metadata) => metadata.payloadIndex === 0);
  let delivery: Record<string, unknown> | undefined;
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

/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode, encodeCompatible } as const;
