import { describe, expect, it } from "vitest";
import {
  createScheduleCollectionPayload,
  parseSchedulePayload,
} from "#runtime/schedules/payload.js";

const principal = { type: "user", authenticator: "test", principalId: "alice" };
const envelope = {
  payload: { task: "Summarize the week.", destination: "my-dm" },
  scope: "alice",
  principal,
  version: 3 as const,
};

describe("parseSchedulePayload", () => {
  it("rejects the old delivery envelope instead of guessing its callback payload", () => {
    expect(() =>
      parseSchedulePayload({
        eve: { application: "fixture", collection: "requests", version: 2 },
        envelope: {
          version: 2,
          request: "Summarize the week.",
          metadata: {},
          deliveries: { log: {} },
          scope: "alice",
          principal,
        },
      }),
    ).toThrow("recreate the schedule");
  });

  it("bounds the complete persisted envelope and rejects resource mismatch", () => {
    expect(() =>
      createScheduleCollectionPayload({
        application: "fixture",
        collection: "requests",
        envelope: { ...envelope, payload: "x".repeat(64 * 1024) },
      }),
    ).toThrow("recreate the schedule");
    const stored = createScheduleCollectionPayload({
      application: "fixture",
      collection: "requests",
      envelope,
    });
    expect(() =>
      parseSchedulePayload(stored, { application: "other", collection: "requests" }),
    ).toThrow("identity changed");
  });
});
