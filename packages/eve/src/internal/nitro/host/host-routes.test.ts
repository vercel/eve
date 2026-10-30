import { describe, expect, it } from "vitest";

import type { CompiledAgentManifest, CompiledChannelDefinition } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import { EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN, EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { createHostRouteTable } from "#internal/nitro/host/host-routes.js";
import { EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH } from "#internal/schedules/consumer-route.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

type TableInput = Parameters<typeof createHostRouteTable>[0];

function channel(method: ChannelRouteMethod, urlPath: string): CompiledChannelDefinition {
  return {
    kind: "channel",
    logicalPath: "channels/probe.ts",
    method,
    name: "probe",
    sourceId: "app:probe",
    sourceKind: "module",
    urlPath,
  };
}

function manifest(
  input: {
    readonly connections?: readonly { connectionName: string; experimental_events?: true }[];
    readonly effective?: readonly CompiledChannelDefinition[];
    readonly preflight?: readonly string[];
    readonly vercelScheduleCollection?: boolean;
    readonly world?: string;
  } = {},
): TableInput["manifest"] {
  return {
    channelRoutes: {
      effective: input.effective ?? [channel("POST", "/messages")],
      preflight: (input.preflight ?? []).map((urlPath) => ({
        cors: {},
        method: "OPTIONS" as const,
        sourceIds: ["app:probe"],
        urlPath,
      })),
      shadowed: [],
    },
    config: {
      name: "probe-agent",
      ...(input.world !== undefined && { experimental: { workflow: { world: input.world } } }),
    } as CompiledAgentManifest["config"],
    connections: (input.connections ?? []) as CompiledAgentManifest["connections"],
    scheduleCollections: (input.vercelScheduleCollection === true
      ? [{ providerKind: "vercel" }]
      : []) as CompiledAgentManifest["scheduleCollections"],
  };
}

const DAILY: ScheduleRegistration = {
  cron: "0 0 * * *",
  description: "Run daily.",
  logicalPath: "schedules/daily.md",
  scheduleId: "daily",
  sourceId: "app:daily",
  taskName: "eve.schedule.daily",
};

function table(input: Partial<TableInput> = {}) {
  return createHostRouteTable({
    manifest: manifest(),
    mode: "production",
    scheduleRegistrations: [],
    vercel: false,
    ...input,
  });
}

function summarize(routes: ReturnType<typeof table>["routes"]) {
  return routes.map((route) => `${route.kind} ${route.method} ${route.path}`);
}

describe("createHostRouteTable", () => {
  it("keeps compiler route order, then preflights, host routes, and the workflow route last", () => {
    const input = {
      manifest: manifest({
        connections: [{ connectionName: "issues", experimental_events: true }],
        effective: [channel("POST", "/b"), channel("GET", "/a")],
        preflight: ["/a"],
      }),
    };

    expect(summarize(table(input).routes)).toEqual([
      "channel POST /b",
      "channel GET /a",
      "channel-preflight OPTIONS /a",
      "connection-event POST /eve/v1/hooks/issues",
      `workflow ALL ${EVE_WORKFLOW_FLOW_ROUTE_PATH}`,
    ]);
    expect(summarize(table({ ...input, mode: "development" }).routes)).toEqual([
      "channel POST /b",
      "channel GET /a",
      "channel-preflight OPTIONS /a",
      "connection-event POST /eve/v1/hooks/issues",
      `development-schedule POST ${EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN}`,
      `workflow ALL ${EVE_WORKFLOW_FLOW_ROUTE_PATH}`,
    ]);
  });

  it("gives GET routes without a HEAD sibling the methods their path allows", () => {
    const { routes } = table({
      manifest: manifest({
        effective: [
          channel("GET", "/stream"),
          channel("POST", "/stream"),
          channel("GET", "/health"),
          channel("HEAD", "/health"),
          channel("GET", "/voice"),
          channel("WEBSOCKET", "/voice"),
        ],
        preflight: ["/stream"],
      }),
    });

    expect(
      routes.map((route) => [
        `${route.method} ${route.path}`,
        "allow" in route ? route.allow : undefined,
      ]),
    ).toEqual([
      ["GET /stream", ["GET", "POST", "OPTIONS"]],
      ["POST /stream", undefined],
      ["GET /health", undefined],
      ["HEAD /health", undefined],
      ["GET /voice", ["GET"]],
      ["WEBSOCKET /voice", undefined],
      ["OPTIONS /stream", undefined],
      [`ALL ${EVE_WORKFLOW_FLOW_ROUTE_PATH}`, undefined],
    ]);
  });

  it("matches a path's methods across parameter names", () => {
    const { routes } = table({
      manifest: manifest({
        effective: [
          channel("GET", "/items/:id"),
          channel("HEAD", "/items/:itemId"),
          channel("GET", "/orders/:id"),
          channel("POST", "/orders/:orderId"),
        ],
      }),
    });

    expect(
      routes
        .filter((route) => route.method === "GET")
        .map((route) => [route.path, "allow" in route ? route.allow : undefined]),
    ).toEqual([
      ["/items/:id", undefined],
      ["/orders/:id", ["GET", "POST"]],
    ]);
  });

  it("mounts only opted-in connection receivers and rejects one that collides with a route", () => {
    expect(
      summarize(
        table({
          manifest: manifest({
            connections: [
              { connectionName: "issues", experimental_events: true },
              { connectionName: "docs" },
            ],
          }),
        }).routes,
      ).filter((route) => route.startsWith("connection-event")),
    ).toEqual(["connection-event POST /eve/v1/hooks/issues"]);

    expect(() =>
      table({
        manifest: manifest({
          connections: [{ connectionName: "issues", experimental_events: true }],
          effective: [channel("POST", "/eve/v1/hooks/issues")],
        }),
      }),
    ).toThrow("Connection event receiver conflicts with an existing route: /eve/v1/hooks/issues");
  });

  it.each([
    { mode: "development", vercel: false, tasks: 0, cron: false, consumer: false },
    { mode: "production", vercel: false, tasks: 1, cron: false, consumer: false },
    { mode: "production", vercel: true, tasks: 1, cron: true, consumer: true },
  ] as const)(
    "registers schedules for $mode (vercel: $vercel)",
    ({ consumer, cron, mode, tasks, vercel }) => {
      const result = table({
        manifest: manifest({ vercelScheduleCollection: true }),
        mode,
        scheduleRegistrations: [DAILY],
        vercel,
      });

      expect(result.scheduleTasks).toHaveLength(tasks);
      expect(result.cronHandlerRoute?.startsWith(`${EVE_ROUTE_PREFIX}/cron/`) ?? false).toBe(cron);
      expect(result.routes.find((route) => route.kind === "schedule-consumer")).toEqual(
        consumer
          ? {
              kind: "schedule-consumer",
              method: "POST",
              path: EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
              vercelFunction: "schedule-queue",
            }
          : undefined,
      );
    },
  );

  it("mints a fresh unguessable cron path per table", () => {
    const input = { scheduleRegistrations: [DAILY], vercel: true };

    expect(table(input).cronHandlerRoute).toMatch(
      new RegExp(`^${EVE_ROUTE_PREFIX}/cron/[A-Za-z0-9_-]{43}$`),
    );
    expect(table(input).cronHandlerRoute).not.toBe(table(input).cronHandlerRoute);
    expect(table({ vercel: true }).cronHandlerRoute).toBeUndefined();
  });

  it.each([
    { mode: "development", vercel: false, world: undefined, direct: false },
    { mode: "development", vercel: false, world: "@workflow/world-postgres", direct: true },
    { mode: "production", vercel: false, world: undefined, direct: false },
    { mode: "production", vercel: false, world: "@workflow/world-postgres", direct: true },
    { mode: "production", vercel: true, world: "@workflow/world-postgres", direct: false },
  ] as const)(
    "dispatches workflow queues in process for $mode with world $world (vercel: $vercel): $direct",
    ({ direct, mode, vercel, world }) => {
      const workflow = table({ manifest: manifest({ world }), mode, vercel }).routes.at(-1);

      expect(workflow).toEqual({
        kind: "workflow",
        method: "ALL",
        path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
        vercelFunction: "workflow-queue",
        ...(direct && { directQueuePrefix: "__eve70726f62652d6167656e74_wkf_workflow_" }),
      });
    },
  );
});
