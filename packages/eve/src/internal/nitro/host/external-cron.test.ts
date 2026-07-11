import { describe, expect, it } from "vitest";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import {
  applyExternalCronHandlerRoute,
  isExternalCronEnabled,
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
];

describe("isExternalCronEnabled", () => {
  it("accepts 1 and true, case- and whitespace-insensitively", () => {
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "1" })).toBe(true);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "true" })).toBe(true);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: " TRUE " })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isExternalCronEnabled({})).toBe(false);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "" })).toBe(false);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "0" })).toBe(false);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "false" })).toBe(false);
    expect(isExternalCronEnabled({ EVE_EXTERNAL_CRON: "yes" })).toBe(false);
  });
});

describe("applyExternalCronHandlerRoute", () => {
  it("registers a POST handler at an unguessable route with the schedules baked in", () => {
    const nitro = createNitroStub();

    const route = applyExternalCronHandlerRoute(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      registrations: REGISTRATIONS,
    });

    expect(route.startsWith(`${EVE_ROUTE_PREFIX}/cron/`)).toBe(true);
    expect(nitro.options.handlers).toEqual([
      {
        handler: "#eve-route-external-cron",
        method: "POST",
        route,
      },
    ]);

    const virtualSource = nitro.options.virtual["#eve-route-external-cron"];
    expect(virtualSource).toContain("handleExternalCronRequest");
    expect(virtualSource).toContain(
      JSON.stringify({
        artifactsConfig: ARTIFACTS_CONFIG,
        schedules: [
          { cron: "0 8 * * *", name: "daily", taskName: "eve.schedule.daily" },
          { cron: "*/5 * * * *", name: "heartbeat", taskName: "eve.schedule.heartbeat" },
        ],
      }),
    );
  });

  it("registers exactly one manifest write on the compiled hook", () => {
    const nitro = createNitroStub();

    applyExternalCronHandlerRoute(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      registrations: REGISTRATIONS,
    });

    // The write-out itself (and its content) is covered by the
    // integration test — unit tests stay hermetic.
    expect(nitro.compiledHooks).toHaveLength(1);
  });
});

type NitroStub = ExternalCronNitro & {
  compiledHooks: Array<() => Promise<void> | void>;
};

function createNitroStub(): NitroStub {
  const compiledHooks: Array<() => Promise<void> | void> = [];
  return {
    compiledHooks,
    hooks: {
      hook(name, fn) {
        if (name === "compiled") {
          compiledHooks.push(fn);
        }
      },
    },
    options: {
      handlers: [],
      output: { dir: "/tmp/fake-output" },
      virtual: {},
    },
  };
}
