import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV6Schema } from "#execution/wire/session-inbox-wire.v6.js";

describe("session inbox wire v6", () => {
  it("round-trips session-owned task cancellation", () => {
    const wire = sessionInboxWire.encode(
      { kind: "cancel", tasks: true, turnId: "turn_1" },
      { version: 6 },
    );

    expect(wire).toEqual({ kind: "cancel", tasks: true, turnId: "turn_1", version: 6 });
    expect(sessionInboxWireDecoder.decode(wire)).toEqual({
      kind: "cancel",
      taskId: undefined,
      tasks: true,
      turnId: "turn_1",
    });
  });

  it("keeps the v6 cancel schema strict", () => {
    expect(
      sessionInboxWireV6Schema.safeParse({ kind: "cancel", tasks: "true", version: 6 }).success,
    ).toBe(false);
    expect(
      sessionInboxWireV6Schema.safeParse({ extra: true, kind: "cancel", version: 6 }).success,
    ).toBe(false);
  });

  it.each([
    { variant: "deliver", version: 0 } as const,
    { variant: "send", version: 0 } as const,
    { version: 1 } as const,
    { version: 2 } as const,
    { version: 3 } as const,
    { version: 4 } as const,
    { version: 5 } as const,
  ])("fails closed when encoding tasks:true for old target %o", (target) => {
    expect(() => sessionInboxWire.encode({ kind: "cancel", tasks: true }, target)).toThrowError(
      SessionInboxWireError,
    );
  });

  it.each([1, 2, 3, 4, 5] as const)(
    "preserves ordinary cancellation for v%i consumers",
    (version) => {
      expect(sessionInboxWire.encode({ kind: "cancel", turnId: "turn_1" }, { version })).toEqual({
        kind: "cancel",
        turnId: "turn_1",
        version,
      });
    },
  );
});
