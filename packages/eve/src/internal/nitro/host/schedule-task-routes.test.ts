import type { Nitro } from "nitro/types";
import { describe, expect, it } from "vitest";

import {
  EVE_SCHEDULE_TASK_NAME_PREFIX,
  createScheduleRegistrations,
  type ScheduleRegistration,
} from "#runtime/schedules/register.js";
import {
  registerScheduleTaskHandlers,
  removeScheduleTaskHandlers,
  syncScheduleTaskHandlers,
} from "#internal/nitro/host/schedule-task-routes.js";

const DISPATCH_MODULE_PATH = "/framework/schedule-task.ts";

const ARTIFACTS_CONFIG = {
  appRoot: "/tmp/test-agent",
  dev: false,
} as const;

describe("schedule task routes", () => {
  it("registers virtual task handlers and cron entries for compiled schedules", () => {
    const nitro = createNitroStub();

    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registrations: createScheduleRegistrations([
        {
          cron: "0 8 * * *",
          hasRun: false,
          name: "daily-digest",
          logicalPath: "schedules/daily-digest.mjs",
          markdown: "Send a digest.",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
        {
          cron: "0 8 * * *",
          hasRun: false,
          name: "weekly-cleanup",
          logicalPath: "schedules/weekly-cleanup.mjs",
          markdown: "Run maintenance.",
          sourceId: "schedules/weekly-cleanup.mjs",
          sourceKind: "module",
        },
      ]),
    });

    expect(nitro.options.experimental.tasks).toBe(true);
    expect(nitro.options.tasks).toEqual({
      "eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM": {
        description: 'Run eve schedule "daily-digest" from "schedules/daily-digest.mjs".',
        handler: "#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM",
      },
      "eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw": {
        description: 'Run eve schedule "weekly-cleanup" from "schedules/weekly-cleanup.mjs".',
        handler: "#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw",
      },
    });
    expect(nitro.options.scheduledTasks).toEqual({
      "0 8 * * *": [
        "eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM",
        "eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw",
      ],
    });

    const virtualSource =
      nitro.options.virtual["#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM"];
    expect(virtualSource).toBeDefined();
    // The virtual module exports a plain task object so Nitro can call
    // `handler.run(event)` at cron-trigger time. We avoid `defineTask`
    // because it imports from `"nitro/task"`, which is unavailable in
    // production deployments where `nitro` is a build-only dependency.
    expect(virtualSource).not.toContain("nitro/task");
    expect(virtualSource).not.toContain("defineTask");
    expect(virtualSource).toContain(
      `import { dispatchScheduleTask } from ${JSON.stringify(DISPATCH_MODULE_PATH)};`,
    );
    expect(virtualSource).toContain(`const config = ${JSON.stringify(ARTIFACTS_CONFIG)};`);
    expect(virtualSource).toContain("export default {");
    expect(virtualSource).toContain("async run(event)");
    expect(virtualSource).toContain("dispatchScheduleTask(event.name, config)");
  });

  it("does nothing when there are no registrations", () => {
    const nitro = createNitroStub();

    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registrations: [],
    });

    expect(nitro.options.experimental.tasks).toBeFalsy();
    expect(nitro.options.tasks).toEqual({});
    expect(nitro.options.scheduledTasks).toEqual({});
    expect(nitro.options.virtual).toEqual({});
  });

  it("removes only eve-owned task entries, virtual modules, and cron mappings", () => {
    const nitro = createNitroStub({
      scheduledTasks: {
        "0 8 * * *": ["eve.schedule.example", "user-task"],
        "0 0 * * *": "eve.schedule.alone",
      },
      tasks: {
        "eve.schedule.example": { description: "eve", handler: "#eve-schedule-task/example" },
        "eve.schedule.alone": { description: "eve", handler: "#eve-schedule-task/alone" },
        "user-task": { description: "user", handler: "/user/task.ts" },
      },
      virtual: {
        "#eve-schedule-task/example": "...",
        "#eve-schedule-task/alone": "...",
        "#user/virtual": "...",
      },
    });

    removeScheduleTaskHandlers(nitro);

    expect(nitro.options.tasks).toEqual({
      "user-task": { description: "user", handler: "/user/task.ts" },
    });
    expect(nitro.options.virtual).toEqual({
      "#user/virtual": "...",
    });
    expect(nitro.options.scheduledTasks).toEqual({
      "0 8 * * *": "user-task",
    });
  });

  it("syncs registrations and reports whether the registration set changed", () => {
    const nitro = createNitroStub();
    const previous = makeRegistration({
      cron: "0 8 * * *",
      logicalPath: "schedules/daily.md",
      scheduleId: "daily",
      sourceId: "schedules/daily.md",
    });
    const next = makeRegistration({
      cron: "0 0 * * *",
      logicalPath: "schedules/nightly.md",
      scheduleId: "nightly",
      sourceId: "schedules/nightly.md",
    });

    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registrations: [previous],
    });

    const changed = syncScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      next: [next],
      previous: [previous],
    });

    expect(changed).toBe(true);
    expect(nitro.options.tasks[previous.taskName]).toBeUndefined();
    expect(nitro.options.tasks[next.taskName]).toBeDefined();
    expect(nitro.options.scheduledTasks).toEqual({
      [next.cron]: next.taskName,
    });

    const unchanged = syncScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      next: [next],
      previous: [next],
    });

    expect(unchanged).toBe(false);
    expect(nitro.options.tasks[next.taskName]).toBeDefined();
  });
});

function createNitroStub(
  input: {
    scheduledTasks?: Record<string, string | string[]>;
    tasks?: Record<string, { description?: string; handler?: string }>;
    virtual?: Record<string, string>;
  } = {},
): Nitro {
  return {
    options: {
      experimental: {
        tasks: false,
      },
      scheduledTasks: input.scheduledTasks ?? {},
      tasks: input.tasks ?? {},
      virtual: input.virtual ?? {},
    },
  } as unknown as Nitro;
}

function makeRegistration(input: {
  cron: string;
  logicalPath: string;
  scheduleId: string;
  sourceId: string;
}): ScheduleRegistration {
  return {
    cron: input.cron,
    description: `Run schedule "${input.scheduleId}".`,
    logicalPath: input.logicalPath,
    scheduleId: input.scheduleId,
    sourceId: input.sourceId,
    taskName: `${EVE_SCHEDULE_TASK_NAME_PREFIX}${input.scheduleId}`,
  };
}
