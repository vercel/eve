import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { Durable } from "#execution/durable.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { testEntities } from "#internal/testing/test-platform.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { builtInHosts, type App } from "#runtime/app.js";
import { createLifetime } from "#runtime/lifetime.js";
import {
  deliverScheduleOccurrence,
  registerAuthoredSchedules,
  runAuthoredSchedule,
} from "#runtime/schedules/deliver.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";

const ALICE = {
  attributes: {},
  authenticator: "fixture",
  principalId: "alice",
  principalType: "user",
};

function secondApp(): App {
  return {
    platform: testEntities(),
    durable: {} as Durable,
    hosts: builtInHosts(),
    lifetime: createLifetime(),
  };
}

describe("schedules delivered from another process", () => {
  it("runs a dynamic schedule occurrence that a second app instance receives", async () => {
    const run = vi.fn();
    const reminders = defineDynamicSchedules({
      inputSchema: z.object({ task: z.string() }).strict(),
      provider: inMemoryScheduleProvider(),
      auth: () => ALICE,
      run,
    });
    const test = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/reminders.ts",
          loadNamespace: async () => ({ default: reminders }),
        },
      ],
    });
    const payload = createScheduleCollectionPayload({
      application: test.manifest.config.name,
      collection: "reminders",
      envelope: {
        version: 3,
        payload: { task: "Send Bob the release notes." },
        scope: "alice",
        principal: { type: "user", authenticator: "fixture", principalId: "alice" },
      },
    });
    const occurrence = {
      executionId: "exec_alice_1",
      name: "release-notes",
      scheduleId: "sch_alice",
      scheduledAt: "2026-11-24T09:00:00.000Z",
    };

    await test.run(() => deliverScheduleOccurrence(secondApp(), { payload, occurrence }));

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({
      payload: { task: "Send Bob the release notes." },
      occurrence: { ...occurrence, collection: "reminders" },
    });
    await expect(
      test.run(() =>
        deliverScheduleOccurrence(secondApp(), {
          payload: { ...payload, eve: { ...payload.eve, application: "bob-agent" } },
          occurrence,
        }),
      ),
    ).rejects.toThrow(
      `The schedule "release-notes" belongs to the agent "bob-agent", and this app runs "${test.manifest.config.name}". Deliver the occurrence to the app that made the schedule.`,
    );
  });

  it("gives authored schedules to the platform's Triggers, which runs them from a second app instance", async () => {
    const daily = vi.fn();
    const test = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/digest.ts",
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 9 * * 1-5", run: daily }),
          }),
        },
      ],
    });
    const register = vi.fn();
    const triggers = () => ({ schedules: inMemoryScheduleProvider(), register });

    await test.run(() =>
      registerAuthoredSchedules(
        testEntities({ build: { schedules: { authored: true } }, triggers }),
      ),
    );
    await test.run(() => registerAuthoredSchedules(testEntities({ triggers })));

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith([{ name: "digest", cron: "0 9 * * 1-5" }]);
    await expect(
      test.run(() =>
        registerAuthoredSchedules(
          testEntities({
            build: { schedules: { authored: true } },
            triggers: () => ({ schedules: inMemoryScheduleProvider() }),
          }),
        ),
      ),
    ).rejects.toThrow(
      "The platform sets build.schedules.authored, and its triggers give no register(). Give triggers.register() in the platform, or remove build.schedules.authored to run authored schedules on eve's scheduler.",
    );

    await test.run(() => runAuthoredSchedule(secondApp(), "digest"));

    expect(daily).toHaveBeenCalledOnce();
    await expect(test.run(() => runAuthoredSchedule(secondApp(), "weekly"))).rejects.toThrow(
      'This agent has no authored schedule "weekly". Pass a name that Triggers.register() received.',
    );
  });

  it("skips an authored schedule when schedules are disabled in the process", async () => {
    const daily = vi.fn();
    const test = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/digest.ts",
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 9 * * 1-5", run: daily }),
          }),
        },
      ],
    });
    vi.stubEnv("EVE_SCHEDULES_DISABLED", "1");
    try {
      await test.run(() => runAuthoredSchedule(secondApp(), "digest"));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(daily).not.toHaveBeenCalled();
  });

  it("calls register() on the platform's Triggers with its own receiver", async () => {
    const test = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/digest.ts",
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 9 * * 1-5", run: vi.fn() }),
          }),
        },
      ],
    });
    class AliceTriggers {
      readonly schedules = inMemoryScheduleProvider();
      #registered: string[] = [];
      register(schedules: readonly { readonly name: string }[]): void {
        this.#registered = schedules.map((schedule) => schedule.name);
      }
      get registered(): readonly string[] {
        return this.#registered;
      }
    }
    const triggers = new AliceTriggers();

    await test.run(() =>
      registerAuthoredSchedules(
        testEntities({ build: { schedules: { authored: true } }, triggers: () => triggers }),
      ),
    );

    expect(triggers.registered).toEqual(["digest"]);
  });
});
