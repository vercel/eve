import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { sessionInboxWire, SessionInboxWireError } from "#execution/wire/session-inbox-wire.js";

describe("session inbox wire policy", () => {
  it("rejects a present non-numeric version before normalization", () => {
    expect(() =>
      sessionInboxWire.decode({ kind: "deliver", payloads: [], version: undefined }),
    ).toThrowError(SessionInboxWireError);
  });

  it("migrates version 5 cancel commands without enabling owned-task cancellation", () => {
    expect(sessionInboxWire.decode({ kind: "cancel", version: 5 })).toEqual({
      kind: "cancel",
      taskId: undefined,
      tasks: undefined,
      turnId: undefined,
    });
  });

  it("normalizes cross-realm records before running pure migrations", () => {
    const wire = runInNewContext(`({
      caller: undefined,
      kind: "deliver",
      payloads: [{ message: "legacy", omitted: undefined }],
      version: 1,
    })`);

    expect(sessionInboxWire.decode(wire)).toEqual({
      auth: undefined,
      caller: undefined,
      kind: "deliver",
      payloads: [{ message: "legacy" }],
      requestId: undefined,
    });
  });
});
