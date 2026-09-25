import { describe, expect, it } from "vitest";

import { compileFromMemory } from "../src/compiler/compile-from-memory.js";
import { defineSchedule } from "../src/public/definitions/schedule.js";
import { resolveSchedules } from "../src/runtime/schedules/resolve-schedule.js";

describe("resolveSchedules", () => {
  it("hydrates effective compiled schedules into runtime-owned models", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 8 * * *", run: async () => undefined }),
          }),
          logicalPath: "schedules/daily-digest.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 0 * * 0", markdown: "Clean stale data." }),
          }),
          logicalPath: "schedules/cleanup.ts",
        },
      ],
    });

    await expect(resolveSchedules({ manifest })).resolves.toEqual([
      expect.objectContaining({
        cron: "0 8 * * *",
        hasRun: true,
        name: "daily-digest",
      }),
      expect.objectContaining({
        cron: "0 0 * * 0",
        hasRun: false,
        markdown: "Clean stale data.",
        name: "cleanup",
      }),
    ]);
  });
});
