import { expect, it } from "vitest";
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
