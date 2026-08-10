import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  encodeSessionCommandV1,
  type SessionInboxWireV1,
} from "#execution/wire/session-inbox-wire.v1.js";

/** Current wire type; callers stay version-agnostic. */
export type SessionInboxWire = SessionInboxWireV1;

/** Encodes a session command with the current wire version. */
export function encodeSessionCommand(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWire {
  return encodeSessionCommandV1(command);
}
