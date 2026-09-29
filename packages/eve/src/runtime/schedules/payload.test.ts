import { describe, expect, it } from "vitest";

import { parseSchedulePayload } from "#runtime/schedules/payload.js";

const principal = { type: "user", authenticator: "test", principalId: "alice" };
const envelope = { request: "Summarize the week.", scope: "alice", principal, metadata: {} };

describe("parseSchedulePayload", () => {
  it.each([
    ["an envelope stored before deliveries were required", { ...envelope, version: 1 }],
    ["an envelope without a delivery", { ...envelope, version: 2, deliveries: {} }],
  ])("rejects %s so the schedule must be recreated", (_label, stored) => {
    expect(() =>
      parseSchedulePayload({
        eve: { application: "fixture", collection: "requests", version: 2 },
        envelope: stored,
      }),
    ).toThrow("recreate the schedule");
  });
});
