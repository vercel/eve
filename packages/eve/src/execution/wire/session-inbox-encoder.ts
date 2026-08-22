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
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV1;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;
type VersionedSessionInboxEncoder = (command: SessionInboxCommand) => unknown;

const versionedEncoders = {
  1: encodeSessionCommandV1,
} satisfies Record<SessionInboxWireVersion, VersionedSessionInboxEncoder>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
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
): SessionInboxWireV1 | Record<string, unknown>;
function encode(
  command: SessionInboxCommand,
  target: SessionInboxWireTarget,
): SessionInboxWireV1 | Record<string, unknown> {
  if (target.version === 0) {
    return encodeSessionCommandV0(encodeSessionCommandV1(command), target.variant);
  }
  if (isSessionInboxWireVersion(target.version)) {
    return versionedEncoders[target.version](command) as SessionInboxWireV1;
  }
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
}

/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode } as const;
