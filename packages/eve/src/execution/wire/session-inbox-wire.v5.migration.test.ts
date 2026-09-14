import { describe, expect, it } from "vitest";

import { sessionInboxWireV4Migration } from "#execution/wire/session-inbox-wire.v5.migration.js";

describe("session inbox wire v5 migration", () => {
  it("rejects malformed direct migration input", () => {
    expect(() => sessionInboxWireV4Migration.migrate(null)).toThrow(
      "session inbox wire v4 value is not an object",
    );
  });

  it("preserves a version-4 payload while advancing its version", () => {
    expect(
      sessionInboxWireV4Migration.migrate({
        kind: "deliver",
        payload: { message: "hello" },
        payloads: [{ message: "hello" }],
        version: 4,
      }),
    ).toEqual({
      kind: "deliver",
      payload: { message: "hello" },
      payloads: [{ message: "hello" }],
      version: 5,
    });
  });
});
