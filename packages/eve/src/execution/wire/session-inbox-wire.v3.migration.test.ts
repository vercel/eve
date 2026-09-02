import { describe, expect, it } from "vitest";

import { sessionInboxWireV2Migration } from "#execution/wire/session-inbox-wire.v3.migration.js";

describe("session inbox wire v3 migration", () => {
  it("stamps controls with version 3", () => {
    expect(sessionInboxWireV2Migration.migrate({ kind: "clear", version: 2 })).toEqual({
      kind: "clear",
      version: 3,
    });
  });

  it("preserves v2 deliveries without inventing deployment provenance", () => {
    expect(
      sessionInboxWireV2Migration.migrate({
        kind: "deliver",
        payload: { message: "legacy" },
        payloads: [{ message: "legacy" }],
        version: 2,
      }),
    ).toEqual({
      kind: "deliver",
      payload: { message: "legacy" },
      payloads: [{ message: "legacy" }],
      version: 3,
    });
  });
});
