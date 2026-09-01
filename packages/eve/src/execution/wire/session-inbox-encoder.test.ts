import { describe, expect, it } from "vitest";

import {
  SessionInboxWireError,
  type SessionInboxWireTarget,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";

const legacyTargets = [
  { variant: "deliver", version: 0 },
  { variant: "send", version: 0 },
  { version: 1 },
] satisfies readonly SessionInboxWireTarget[];
const activityObserver = {
  sink: { url: "https://example.com/activity", version: 1 as const },
};

describe("session inbox encoder", () => {
  it.each(
    legacyTargets.flatMap(
      (target) =>
        [
          [target, undefined],
          [target, activityObserver],
        ] as const,
    ),
  )("projects caller fields for target %o with activity observer %o", (target, observer) => {
    const caller = {
      activityObserver: observer,
      callId: "call-1",
      futureCallerField: "future-value",
      replyTo: { kind: "hook" as const, token: "callback-token" },
      subagentName: "researcher",
    };

    const wire = sessionInboxWire.encode(
      { caller, kind: "send", payload: { message: "legacy" } },
      target,
    );

    expect(wire).toHaveProperty("caller", {
      callId: "call-1",
      replyTo: { kind: "hook", token: "callback-token" },
      subagentName: "researcher",
    });
  });

  it.each(legacyTargets)("wraps malformed caller fields for target %o", (target) => {
    expect(() =>
      sessionInboxWire.encode(
        {
          caller: {
            callId: 1 as never,
            replyTo: { kind: "hook", token: "callback-token" },
            subagentName: "researcher",
          },
          kind: "send",
          payload: { message: "legacy" },
        },
        target,
      ),
    ).toThrowError(SessionInboxWireError);
  });
});
