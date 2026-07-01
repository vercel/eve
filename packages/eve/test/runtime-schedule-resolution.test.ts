import { describe, expect, it } from "vitest";

import { createCompiledAgentManifest } from "../src/compiler/manifest.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import { resolveSchedules } from "../src/runtime/schedules/resolve-schedule.js";

describe("resolveSchedules", () => {
  it("hydrates compiled authored schedules into runtime-owned models", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      schedules: [
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
      ],
    });

    await expect(
      resolveSchedules({
        manifest,
      }),
    ).resolves.toEqual([
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
    ]);
  });
});
