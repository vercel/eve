import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV7Schema } from "#execution/wire/session-inbox-wire.v7.js";

const caller = {
  activityObserver: {
    sink: { url: "https://example.com/eve/v1/activity/opaque-token", version: 1 as const },
    workIdentity: {
      callId: "call-1",
      id: "work:call-1",
      kind: "task" as const,
      label: "Investigator",
      name: "researcher",
      rootSessionId: "root",
      rootTurnId: "turn",
    },
  },
  callId: "call-1",
  replyTo: {
    kind: "callback" as const,
    token: "callback-token",
    url: "https://example.com/callback",
  },
  subagentName: "researcher",
};

describe("session inbox wire v7", () => {
  it("round-trips delegated activity labels", () => {
    const wire = sessionInboxWire.encode(
      { caller, kind: "send", payload: { message: "observe" } },
      { version: 7 },
    );

    expect(wire).toMatchObject({ caller, version: 7 });
    expect(sessionInboxWireDecoder.decode(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      caller,
      kind: "deliver",
      payloads: [{ message: "observe" }],
    });
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("omits activity labels for v%i consumers", (version) => {
    const wire = sessionInboxWire.encode(
      { caller, kind: "send", payload: { message: "observe" } },
      { version },
    );

    expect(wire).not.toHaveProperty("caller.activityObserver.workIdentity.label");
  });

  it("keeps the v7 deliver schema strict", () => {
    expect(
      sessionInboxWireV7Schema.safeParse({
        caller: { ...caller, activityObserver: { ...caller.activityObserver, extra: true } },
        kind: "deliver",
        payload: {},
        payloads: [{}],
        version: 7,
      }).success,
    ).toBe(false);
  });
});
