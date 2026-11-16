import { describe, expect, it } from "vitest";

import {
  createVercelScheduleName,
  VERCEL_SCHEDULE_NAME_MAX_LENGTH,
} from "#internal/nitro/host/vercel-schedule-name.js";

// The schedule name pattern Vercel accepts.
const VERCEL_SCHEDULE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const HASHED = (prefix: string) => new RegExp(`^${prefix.replaceAll(".", "\\.")}-[0-9a-f]{8}$`);

describe("createVercelScheduleName", () => {
  it.each([
    ["heartbeat", "eve.heartbeat"],
    ["billing/sweep", "eve.billing.sweep"],
    ["reports/weekly/digest", "eve.reports.weekly.digest"],
    ["crm__sweep", "eve.crm__sweep"],
    ["daily-digest_v2", "eve.daily-digest_v2"],
  ])("names %j after its schedule", (scheduleId, name) => {
    expect(createVercelScheduleName({ scheduleId })).toBe(name);
  });

  it("adds the agent for a Vercel service build", () => {
    expect(createVercelScheduleName({ agentName: "billing", scheduleId: "heartbeat" })).toBe(
      "eve.billing.heartbeat",
    );
    expect(createVercelScheduleName({ agentName: "billing", scheduleId: "reports/sweep" })).toBe(
      "eve.billing.reports.sweep",
    );
  });

  it("keeps a dotted name apart from the nested name it would read as", () => {
    const nested = createVercelScheduleName({ scheduleId: "a/b" });
    const dotted = createVercelScheduleName({ scheduleId: "a.b" });

    expect(nested).toBe("eve.a.b");
    expect(dotted).toMatch(HASHED("eve.a.b"));
    expect(dotted).not.toBe(nested);
  });

  it.each(["weekly report", "ops@night", "a+b", "résumé", "日次", "..", "a//b"])(
    "makes %j a valid, distinct name",
    (scheduleId) => {
      const name = createVercelScheduleName({ scheduleId });

      expect(name).toMatch(VERCEL_SCHEDULE_NAME);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
      expect(createVercelScheduleName({ scheduleId })).toBe(name);
    },
  );

  it("keeps the readable characters of a name it hashes", () => {
    expect(createVercelScheduleName({ scheduleId: "weekly report" })).toMatch(
      HASHED("eve.weekly.report"),
    );
    expect(createVercelScheduleName({ scheduleId: "日次" })).toMatch(HASHED("eve.schedule"));
  });

  it("hashes an agent name Vercel does not allow", () => {
    expect(createVercelScheduleName({ agentName: "@acme/agent", scheduleId: "sweep" })).toMatch(
      /^eve\.acme\.agent-[0-9a-f]{8}\.sweep$/,
    );
  });

  it("names schedules that differ only in unsupported characters apart", () => {
    const names = ["a b", "a+b", "a@b", "a.b", "a/b"].map((scheduleId) =>
      createVercelScheduleName({ scheduleId }),
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it("cuts a long name to Vercel's limit and keeps it distinct", () => {
    const base = Array.from({ length: 40 }, (_, index) => `folder${index}`).join("/");
    const first = createVercelScheduleName({ agentName: "billing", scheduleId: `${base}/first` });
    const second = createVercelScheduleName({ agentName: "billing", scheduleId: `${base}/second` });

    for (const name of [first, second]) {
      expect(name).toHaveLength(VERCEL_SCHEDULE_NAME_MAX_LENGTH);
      expect(name).toMatch(VERCEL_SCHEDULE_NAME);
      expect(name.startsWith("eve.billing.folder0.")).toBe(true);
    }
    expect(first).not.toBe(second);
  });

  it("leaves a name at Vercel's limit as it is", () => {
    const scheduleId = "a".repeat(VERCEL_SCHEDULE_NAME_MAX_LENGTH - "eve.".length);

    expect(createVercelScheduleName({ scheduleId })).toBe(`eve.${scheduleId}`);
  });
});
