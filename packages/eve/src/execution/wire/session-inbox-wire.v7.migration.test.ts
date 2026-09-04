import { describe, expect, it } from "vitest";

import { sessionInboxWireV6Migration } from "#execution/wire/session-inbox-wire.v7.migration.js";

describe("session inbox wire v7 migration", () => {
  it("rejects malformed direct migration input", () => {
    expect(() => sessionInboxWireV6Migration.migrate(null)).toThrow(
      "session inbox wire v6 value is not an object",
    );
  });

  it("preserves a version-6 payload while advancing its version", () => {
    expect(
      sessionInboxWireV6Migration.migrate({
        kind: "cancel",
        tasks: true,
        version: 6,
      }),
    ).toEqual({
      kind: "cancel",
      tasks: true,
      version: 7,
    });
  });
});
