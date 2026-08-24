import { describe, expect, it } from "vitest";

import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "../src/internal/testing/compiled-manifest.js";
import { resolveSchedules } from "../src/runtime/schedules/resolve-schedule.js";

describe("resolveSchedules", () => {
  it("hydrates compiled authored schedules into runtime-owned models", async () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          logicalPath: "schedules/daily-digest.mjs",
          sourceId: "schedules/daily-digest.mjs",
        },
      ],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
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
