import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV7Schema } from "#execution/wire/session-inbox-wire.v7.js";

describe("session inbox wire v7", () => {
  it("round-trips history restoration", () => {
    const wire = sessionInboxWire.encode({ kind: "restore-history", to: 3 }, { version: 7 });

    expect(wire).toEqual({ kind: "restore-history", to: 3, version: 7 });
    expect(sessionInboxWireDecoder.decode(wire)).toEqual({ kind: "restore-history", to: 3 });
  });

  it("keeps restoration strict", () => {
    expect(
      sessionInboxWireV7Schema.safeParse({ kind: "restore-history", to: -1, version: 7 }).success,
    ).toBe(false);
    expect(
      sessionInboxWireV7Schema.safeParse({
        extra: true,
        kind: "restore-history",
        to: 1,
        version: 7,
      }).success,
    ).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "fails closed for history restoration on v%i consumers",
    (version) => {
      expect(() =>
        sessionInboxWire.encode({ kind: "restore-history", to: 1 }, { version }),
      ).toThrowError(SessionInboxWireError);
    },
  );
});
