import { describe, expect, it } from "vitest";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import {
  createEveVercelOptions,
  EVE_WORKFLOW_FLOW_ROUTE_PATH,
} from "#internal/nitro/host/vercel-build-output-config.js";
import { deriveEveWorkflowQueueTopic } from "#internal/workflow/queue-namespace.js";
import { EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH } from "#internal/schedules/consumer-route.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const FLOW_ROUTE = {
  kind: "workflow",
  method: "ALL",
  path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
  vercelFunction: "workflow-queue",
} as const;
const CONSUMER_ROUTE = {
  kind: "schedule-consumer",
  method: "POST",
  path: EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
  vercelFunction: "schedule-queue",
} as const;
const routeTable = { routes: [FLOW_ROUTE] };

describe("createEveVercelOptions", () => {
  it("returns undefined when the Vercel build output is disabled", () => {
    expect(
      createEveVercelOptions({ agentName: "test-agent", enabled: false, routeTable }),
    ).toBeUndefined();
  });

  it("emits both framework slug and version so the proxy keeps the framework object", () => {
    expect(
      createEveVercelOptions({ agentName: "test-agent", enabled: true, routeTable })?.config,
    ).toEqual({
      version: 3,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    });
  });

  it("declares the queue-triggered workflow flow function through functionRules", () => {
    const options = createEveVercelOptions({ agentName: "test-agent", enabled: true, routeTable });

    expect(options?.functionRules).toEqual({
      [EVE_WORKFLOW_FLOW_ROUTE_PATH]: {
        maxDuration: "max",
        experimentalTriggers: [
          {
            type: "queue/v2beta",
            topic: deriveEveWorkflowQueueTopic("test-agent"),
            consumer: "default",
            retryAfterSeconds: 5,
            initialDelaySeconds: 0,
          },
        ],
        environment: {
          WORKFLOW_PRECONDITION_GUARD: "1",
        },
      },
    });
  });

  it("declares a queue function for each route the table assigns one", () => {
    const withoutCollections = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      routeTable,
    });
    const withCollections = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      routeTable: { routes: [CONSUMER_ROUTE, FLOW_ROUTE] },
    });

    expect(withoutCollections?.functionRules).not.toHaveProperty(
      EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
    );
    expect(withCollections?.functionRules[EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH]).toEqual({
      maxDuration: "max",
      experimentalTriggers: [
        {
          type: "queue/v2beta",
          topic: deriveEveScheduleQueueTopic("test-agent"),
          retryAfterSeconds: 5,
          initialDelaySeconds: 0,
          maxDeliveries: 10,
        },
      ],
      environment: { WORKFLOW_PRECONDITION_GUARD: "1" },
    });
    expect(Object.keys(withCollections?.functionRules ?? {})).toEqual([
      EVE_WORKFLOW_FLOW_ROUTE_PATH,
      EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
    ]);
  });

  it("sets the cron path only when the table has one", () => {
    const cronHandlerRoute = "/eve/v1/cron/token";

    expect(
      createEveVercelOptions({
        agentName: "test-agent",
        enabled: true,
        routeTable: { cronHandlerRoute, routes: [FLOW_ROUTE] },
      })?.cronHandlerRoute,
    ).toBe(cronHandlerRoute);
    expect(
      createEveVercelOptions({ agentName: "test-agent", enabled: true, routeTable }),
    ).not.toHaveProperty("cronHandlerRoute");
  });

  it("omits the public route prefix from the flow environment when none is set", () => {
    for (const publicRoutePrefix of [undefined, ""]) {
      const options = createEveVercelOptions({
        agentName: "test-agent",
        enabled: true,
        routeTable,
        publicRoutePrefix,
      });
      expect(options?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]!.environment).not.toHaveProperty(
        "EVE_PUBLIC_ROUTE_PREFIX",
      );
    }
  });

  it("bakes the normalized public route prefix into the flow function environment", () => {
    const options = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      routeTable,
      publicRoutePrefix: "eve/support/",
    });

    expect(options?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]!.environment).toEqual({
      WORKFLOW_PRECONDITION_GUARD: "1",
      EVE_PUBLIC_ROUTE_PREFIX: "/eve/support",
    });
  });

  it("marks workspace-member flow functions without marking standalone agents", () => {
    const standalone = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      routeTable,
      publicRoutePrefix: "/support",
    });
    const workspaceMember = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      routeTable,
      publicRoutePrefix: "/support",
      workspaceMember: true,
    });

    expect(standalone?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]!.environment).not.toHaveProperty(
      "EVE_INTERNAL_AGENT_WORKSPACE_MEMBER",
    );
    expect(workspaceMember?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]!.environment).toMatchObject(
      {
        EVE_INTERNAL_AGENT_WORKSPACE_MEMBER: "1",
      },
    );
  });
});
