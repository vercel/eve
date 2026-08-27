import { describe, expect, it } from "vitest";

import { isRunControlMessage, isRunReleaseMessage } from "#execution/tool-run/messages.js";

describe("tool run control messages", () => {
  it("distinguishes owner release from cancellation", () => {
    expect(isRunControlMessage({ kind: "release" })).toBe(true);
    expect(isRunReleaseMessage({ kind: "release" })).toBe(true);
    expect(isRunReleaseMessage({ kind: "cancel", reason: "stop" })).toBe(false);
  });
});
