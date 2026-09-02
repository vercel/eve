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
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV3;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;
type VersionedSessionInboxEncoder = (command: SessionInboxCommand) => unknown;

const versionedEncoders = {
  1: (command: SessionInboxCommand) => encodeSessionCommandV1(withoutAcceptedDeployment(command)),
  2: (command: SessionInboxCommand) => encodeSessionCommandV2(withoutAcceptedDeployment(command)),
  3: encodeSessionCommandV3,
} satisfies Record<SessionInboxWireVersion, VersionedSessionInboxEncoder>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
function encode(command: SessionInboxCommand, target: { readonly version: 2 }): SessionInboxWireV2;
function encode(command: SessionInboxCommand, target: { readonly version: 3 }): SessionInboxWireV3;
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
): SessionInboxWireV1 | SessionInboxWireV2 | SessionInboxWireV3 | Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
): SessionInboxWireV1 | SessionInboxWireV2 | SessionInboxWireV3 | Record<string, unknown> {
  if (target.version === 0) {
    const legacy = encodeSessionCommandV0(
      encodeSessionCommandV1(withoutAcceptedDeployment(command)),
      target.variant,
    );
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
      | SessionInboxWireV3;
  }
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
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
/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode } as const;
