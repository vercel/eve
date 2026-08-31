import { describe, expect, it } from "vitest";

import {
  SESSION_INBOX_WIRE_VERSIONS,
  type SessionInboxWireTarget,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";

const targets = [
  { variant: "deliver", version: 0 },
  { variant: "send", version: 0 },
  ...SESSION_INBOX_WIRE_VERSIONS.map((version) => ({ version })),
] satisfies readonly SessionInboxWireTarget[];

const caller = {
  callId: "call-1",
  replyTo: { kind: "hook" as const, token: "callback-token" },
  subagentName: "researcher",
};

function encodeAsJson(
  command: Parameters<typeof sessionInboxWire.encode>[0],
  target: SessionInboxWireTarget,
): unknown {
  return JSON.parse(JSON.stringify(sessionInboxWire.encode(command, target)));
}

describe("session inbox encoder", () => {
  it.each(targets)("treats undefined fields as omitted for target %o", (target) => {
    const omitted = { caller, kind: "send" as const, payload: { message: "hello" } };
    const explicit = { ...omitted, caller: { ...caller, activityObserver: undefined } };

    expect(encodeAsJson(explicit, target)).toStrictEqual(encodeAsJson(omitted, target));
  });
});
