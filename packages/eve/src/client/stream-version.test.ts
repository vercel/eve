import { describe, expect, it } from "vitest";

import { readMessageStreamVersion } from "#client/stream-version.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

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

  // Sessions don't cross v27, so an earlier stream is a deployment this client can't read.
  it.each(["26", "28"] as const)("rejects stream version %s", (version) => {
    expect(() =>
      readMessageStreamVersion(new Headers({ [EVE_STREAM_VERSION_HEADER]: version })),
    ).toThrow(`Unsupported message stream version: ${version}.`);
  });
});
