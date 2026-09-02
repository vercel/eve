import { describe, expect, it } from "vitest";

import { extractScheduledRecoveryNotice } from "#public/channels/scheduled-recovery.js";

const event = {
  details: {
    hint: "Add credits.",
    message: "Free tier requests are rate-limited.",
    name: "AI Gateway free tier rate limit exceeded",
    recovery: {
      attempt: 1,
      delayMs: 42_000,
      kind: "durable-retry",
      maxAttempts: 1,
      status: "scheduled",
    },
    semanticErrorId: "gateway-free-tier-rate-limited",
  },
};

describe("extractScheduledRecoveryNotice", () => {
  it("returns validated scheduled recovery presentation data", () => {
    expect(extractScheduledRecoveryNotice(event)).toMatchObject({
      attempt: 1,
      delayMs: 42_000,
      maxAttempts: 1,
      semanticError: { name: "AI Gateway free tier rate limit exceeded" },
    });
  });

  it.each([
    {},
    { details: { ...event.details, recovery: { ...event.details.recovery, status: "done" } } },
    { details: { ...event.details, recovery: { ...event.details.recovery, delayMs: 0 } } },
    { details: { ...event.details, semanticErrorId: "" } },
  ])("rejects malformed or unscheduled metadata", (candidate) => {
    expect(extractScheduledRecoveryNotice(candidate)).toBeNull();
  });
});
