import { describe, expect, it } from "vitest";

import { readMessageStreamVersion } from "#client/stream-version.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/session-http.js";

describe("readMessageStreamVersion", () => {
  it("accepts the one stream version this client reads", () => {
    expect(
      readMessageStreamVersion(
        new Headers({ [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION }),
      ),
    ).toBe(EVE_MESSAGE_STREAM_VERSION);
  });

  it("rejects a missing version", () => {
    expect(() => readMessageStreamVersion(new Headers())).toThrow(
      `Missing ${EVE_STREAM_VERSION_HEADER} response header.`,
    );
  });

  it.each(["26", "28"] as const)("rejects stream version %s", (version) => {
    expect(() =>
      readMessageStreamVersion(new Headers({ [EVE_STREAM_VERSION_HEADER]: version })),
    ).toThrow(`Unsupported message stream version: ${version}.`);
  });
});
