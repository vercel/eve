import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import {
  applyExternalCronHandlerRoute,
  EVE_CRON_MANIFEST_OUTPUT_PATH,
  type ExternalCronNitro,
} from "#internal/nitro/host/external-cron.js";

const ARTIFACTS_CONFIG = {
  appRoot: "/tmp/test-agent",
  dev: false,
} as const;

const REGISTRATIONS: ScheduleRegistration[] = [
  {
    cron: "0 8 * * *",
    description: 'Run eve schedule "daily".',
    logicalPath: "schedules/daily.md",
    scheduleId: "daily",
    sourceId: "schedules/daily.md",
    taskName: "eve.schedule.daily",
  },
  {
    cron: "*/5 * * * *",
    description: 'Run eve schedule "heartbeat".',
    logicalPath: "schedules/heartbeat.md",
    scheduleId: "heartbeat",
    sourceId: "schedules/heartbeat.md",
    taskName: "eve.schedule.heartbeat",
  },
  {
    cron: "*/5 * * * *",
    description: 'Run eve schedule "sync".',
    logicalPath: "schedules/sync.md",
    scheduleId: "sync",
    sourceId: "schedules/sync.md",
    taskName: "eve.schedule.sync",
  },
];

describe("applyExternalCronHandlerRoute manifest emission", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "eve-external-cron-"));
  });

  afterEach(async () => {
    await rm(outputDir, { force: true, recursive: true });
  });

  it("writes the cron manifest grouped by expression on compiled", async () => {
    const compiledHooks: Array<() => Promise<void> | void> = [];
    const nitro: ExternalCronNitro = {
      hooks: {
        hook(name, fn) {
          if (name === "compiled") {
            compiledHooks.push(fn);
          }
        },
      },
      options: {
        handlers: [],
        output: { dir: outputDir },
        virtual: {},
      },
    };

    const route = applyExternalCronHandlerRoute(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      registrations: REGISTRATIONS,
    });

    expect(compiledHooks).toHaveLength(1);
    await compiledHooks[0]!();

    const manifest = JSON.parse(
      await readFile(join(outputDir, EVE_CRON_MANIFEST_OUTPUT_PATH), "utf8"),
    ) as unknown;
    expect(manifest).toEqual({
      version: 1,
      cronHandlerRoute: route,
      crons: [
        { cron: "0 8 * * *", schedules: ["daily"] },
        { cron: "*/5 * * * *", schedules: ["heartbeat", "sync"] },
      ],
    });
  });
});
