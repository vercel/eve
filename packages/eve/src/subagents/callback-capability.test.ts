import { describe, expect, it } from "vitest";
import {
  createCallbackCapability,
  readCallbackCapability,
} from "#subagents/callback-capability.js";

describe("callback capabilities", () => {
  it("preserves the exact owner and invocation without a lookup", () => {
    const target = {
      kind: "inbox" as const,
      address: { token: "opaque-secret", ownerRunId: "run-1" },
      requestId: "request-1",
    };
    expect(readCallbackCapability(createCallbackCapability(target))).toEqual(target);
  });
  it("never exposes session admission through an external callback", () => {
    expect(() => createCallbackCapability({ kind: "session", token: "slack:thread" })).toThrow(
      "invocation inbox",
    );
    const forged = `eve:callback:${Buffer.from(JSON.stringify({ kind: "session", token: "slack:thread" })).toString("base64url")}`;
    expect(readCallbackCapability(forged)).toBeUndefined();
  });
  it("rejects missing ownership, missing request ids and oversized tokens", () => {
    for (const data of [
      { kind: "inbox", requestId: "id", address: { token: "t" } },
      { kind: "inbox", address: { token: "t", ownerRunId: "r" } },
      { kind: "inbox", requestId: "id", address: null },
      { kind: "inbox", requestId: "id", address: "not-an-address" },
    ]) {
      expect(
        readCallbackCapability(
          `eve:callback:${Buffer.from(JSON.stringify(data)).toString("base64url")}`,
        ),
      ).toBeUndefined();
    }
    expect(readCallbackCapability(`eve:callback:${"a".repeat(5000)}`)).toBeUndefined();
  });
});
