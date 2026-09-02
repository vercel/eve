import { describe, expect, it } from "vitest";

import { sessionInboxWireV1Migration } from "#execution/wire/session-inbox-wire.v2.migration.js";

describe("session inbox wire v2 migration", () => {
  it("stamps controls with version 2", () => {
    expect(sessionInboxWireV1Migration.migrate({ kind: "clear", version: 1 })).toEqual({
      kind: "clear",
      version: 2,
    });
  });

  it("adds the required payload mirror to v1 deliveries", () => {
    expect(
      sessionInboxWireV1Migration.migrate({
        kind: "deliver",
        payloads: [{ message: "legacy" }],
        version: 1,
      }),
    ).toEqual({
      kind: "deliver",
      payload: {},
      payloads: [{ message: "legacy" }],
      version: 2,
    });
  });

  it("preserves an existing payload mirror", () => {
    expect(
      sessionInboxWireV1Migration.migrate({
        kind: "deliver",
        payload: { message: "legacy" },
        payloads: [{ message: "legacy" }],
        version: 1,
      }),
    ).toEqual({
      kind: "deliver",
      payload: { message: "legacy" },
      payloads: [{ message: "legacy" }],
      version: 2,
    });
  });
});
