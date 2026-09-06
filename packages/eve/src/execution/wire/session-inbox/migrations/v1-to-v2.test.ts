import { describe, expect, it } from "vitest";
import { v1ToV2 } from "./v1-to-v2.js";

it("removes only the unsupported caller observer when sending to v1", () => {
  const caller = {
    callId: "call-1",
    replyTo: { kind: "hook" as const, token: "reply" },
    subagentName: "research",
  };
  const old = v1ToV2.down({
    kind: "deliver",
    version: 2,
    payload: { message: "hello" },
    payloads: [{ message: "hello" }],
    caller: {
      ...caller,
      activityObserver: { sink: { url: "https://example.com/activity", version: 1 } },
    },
  });
  expect(old).toMatchObject({ version: 1, caller });
  expect(old.kind === "deliver" && old.caller).not.toHaveProperty("activityObserver");
});

describe("session inbox wire v2 migration", () => {
  it("stamps controls with version 2", () => {
    expect(v1ToV2.up({ kind: "clear", version: 1 })).toEqual({
      kind: "clear",
      version: 2,
    });
  });

  it("adds the required payload mirror to v1 deliveries", () => {
    expect(
      v1ToV2.up({
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
      v1ToV2.up({
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
