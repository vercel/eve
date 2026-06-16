import { describe, expect, it } from "vitest";

import {
  createScheduleRegistrations,
  ScheduleRegistrationError,
} from "../src/runtime/schedules/register.js";

describe("schedule registration", () => {
  it("creates stable Nitro registration inputs from resolved schedules", () => {
    expect(
      createScheduleRegistrations([
        {
          cron: "0 8 * * *",
          hasRun: true,
          name: "daily-digest",
          logicalPath: "schedules/daily-digest.mjs",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
        {
          cron: "0 0 * * 0",
          hasRun: false,
          name: "cleanup",
          logicalPath: "schedules/cleanup.md",
          markdown: "Clean stale data.",
          sourceId: "schedules/cleanup.md",
          sourceKind: "markdown",
        },
      ]),
    ).toEqual([
      {
        cron: "0 0 * * 0",
        description: 'Run eve schedule "cleanup" from "schedules/cleanup.md".',
        logicalPath: "schedules/cleanup.md",
        scheduleId: "cleanup",
        sourceId: "schedules/cleanup.md",
        taskName: "eve.schedule.c2NoZWR1bGVzL2NsZWFudXAubWQ",
      },
      {
        cron: "0 8 * * *",
        description: 'Run eve schedule "daily-digest" from "schedules/daily-digest.mjs".',
        logicalPath: "schedules/daily-digest.mjs",
        scheduleId: "daily-digest",
        sourceId: "schedules/daily-digest.mjs",
        taskName: "eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM",
      },
    ]);
  });

  it("rejects duplicate authored schedule ids", () => {
    expect(() =>
      createScheduleRegistrations([
        {
          cron: "0 8 * * *",
          hasRun: true,
          name: "daily-digest",
          logicalPath: "schedules/daily-digest.mjs",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
        {
          cron: "0 12 * * *",
          hasRun: true,
          name: "daily-digest",
          logicalPath: "schedules/noon-digest.mjs",
          sourceId: "schedules/noon-digest.mjs",
          sourceKind: "module",
        },
      ]),
    ).toThrow(ScheduleRegistrationError);
  });
});
