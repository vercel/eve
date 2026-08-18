import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  encodeSessionCommandV1,
  type SessionInboxWireV1,
} from "#execution/wire/session-inbox-wire.v1.js";
import type { SessionInboxWireTarget } from "#execution/wire/session-inbox-contract.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { encodeSessionCommandV0 } from "#execution/wire/session-inbox-wire.v0.js";

type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV1;

type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, { readonly version: 0 }>;

/** Encodes a command for the selected session-inbox consumer. */
function encode(command: SessionInboxCommand, target: { readonly version: 1 }): SessionInboxWireV1;
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
  const current = encodeSessionCommandV1(command);
  if (target.version === 1) return current;
  if (target.version === 0) return encodeSessionCommandV0(current, target.variant);
  throw new SessionInboxWireError(
    `Cannot encode session inbox payload for unknown wire version ${JSON.stringify((target as { version?: unknown }).version)}.`,
  );
}

/** Server/step-safe producer facade. */
export const sessionInboxWire = { encode } as const;
