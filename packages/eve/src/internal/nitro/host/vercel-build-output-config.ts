import { EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV } from "#internal/application/build-output-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";
import type { HostRouteTable, HostRouteVercelFunction } from "#internal/nitro/host/host-routes.js";
import { createEveScheduleQueueTrigger } from "#internal/schedules/consumer-route.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/flow-route.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export { EVE_WORKFLOW_FLOW_ROUTE_PATH };

const QUEUE_TRIGGERS = {
  "workflow-queue": createEveWorkflowQueueTrigger,
  "schedule-queue": createEveScheduleQueueTrigger,
} satisfies Record<HostRouteVercelFunction, (agentName: string) => object>;

export function createEveVercelOptions(input: {
  agentName: string;
  enabled: boolean;
  publicRoutePrefix?: string;
  routeTable: Pick<HostRouteTable, "cronHandlerRoute" | "routes">;
  workspaceMember?: boolean;
}) {
  if (!input.enabled) {
    return undefined;
  }

  const environment: Record<string, string> = {
    WORKFLOW_PRECONDITION_GUARD: "1",
  };

  const publicRoutePrefix = normalizePublicRoutePrefix(input.publicRoutePrefix);
  if (publicRoutePrefix !== undefined) {
    environment[EVE_PUBLIC_ROUTE_PREFIX_ENV] = publicRoutePrefix;
  }
  if (input.workspaceMember === true) {
    environment[EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV] = "1";
  }

  return {
    config: {
      version: 3 as const,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    },
    ...(input.routeTable.cronHandlerRoute !== undefined && {
      cronHandlerRoute: input.routeTable.cronHandlerRoute,
    }),
    functionRules: Object.fromEntries(
      Object.entries(QUEUE_TRIGGERS).flatMap(([vercelFunction, createTrigger]) =>
        input.routeTable.routes
          .filter((route) => "vercelFunction" in route && route.vercelFunction === vercelFunction)
          .map((route) => [
            route.path,
            {
              maxDuration: "max" as const,
              experimentalTriggers: [createTrigger(input.agentName)],
              environment,
            },
          ]),
      ),
    ),
  };
}
