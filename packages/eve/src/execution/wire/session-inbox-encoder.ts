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
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV2;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;
type VersionedSessionInboxEncoder = (command: SessionInboxCommand) => unknown;

const versionedEncoders = {
  1: (command: SessionInboxCommand) => encodeSessionCommandV1(withoutActivityObserver(command)),
  2: encodeSessionCommandV2,
} satisfies Record<SessionInboxWireVersion, VersionedSessionInboxEncoder>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
function encode(command: SessionInboxCommand, target: { readonly version: 2 }): SessionInboxWireV2;
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
): SessionInboxWireV1 | SessionInboxWireV2 | Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
): SessionInboxWireV1 | SessionInboxWireV2 | Record<string, unknown> {
  if (target.version === 0) {
    return encodeSessionCommandV0(
      encodeSessionCommandV1(withoutActivityObserver(command)),
      target.variant,
    );
  }
  if (isSessionInboxWireVersion(target.version)) {
    return versionedEncoders[target.version](command) as SessionInboxWireV1 | SessionInboxWireV2;
  }
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
}

function withoutActivityObserver(command: SessionInboxCommand): SessionInboxCommand {
  if (!("caller" in command) || command.caller?.activityObserver === undefined) return command;
  const { activityObserver: _activityObserver, ...caller } = command.caller;
  return { ...command, caller };
}

/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode } as const;
