import { describe, expect, it } from "vitest";

import { readMessageStreamVersion } from "#client/stream-version.js";
import { EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

describe("readMessageStreamVersion", () => {
  it.each(["24", "25"] as const)("accepts stream version %s", (version) => {
    expect(readMessageStreamVersion(new Headers({ [EVE_STREAM_VERSION_HEADER]: version }))).toBe(
      version,
    );
  });

  it("rejects a missing version", () => {
    expect(() => readMessageStreamVersion(new Headers())).toThrow(
      `Missing ${EVE_STREAM_VERSION_HEADER} response header.`,
    );
  });

  it("rejects an unsupported version", () => {
    expect(() =>
      readMessageStreamVersion(new Headers({ [EVE_STREAM_VERSION_HEADER]: "26" })),
    ).toThrow("Unsupported message stream version: 26.");
  });
});
