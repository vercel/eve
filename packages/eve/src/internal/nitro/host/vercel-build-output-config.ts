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

// Nitro emits `config.json` routes in `functionRules` key order; this order keeps it stable.
const QUEUE_TRIGGERS = {
  "workflow-queue": createEveWorkflowQueueTrigger,
  "schedule-queue": createEveScheduleQueueTrigger,
} satisfies Record<HostRouteVercelFunction, (agentName: string) => object>;

/**
 * Builds eve's Vercel preset options.
 *
 * Each route that needs its own function gets a `functionRules` entry, so
 * Nitro emits a dedicated `.func` from the same build output carrying the
 * agent's queue trigger, an extended execution window, and the environment
 * the deployed runtime needs. Every other function setting (memory,
 * streaming) is inherited from the base server function config, which pins
 * the Node.js runtime eve requires rather than the build machine's or the
 * app's `engines` version.
 */
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
    // Reject replay decisions made from an event log that missed a
    // concurrent wake.
    WORKFLOW_PRECONDITION_GUARD: "1",
  };

  // Bake the agent's public mount into the flow function so callback-URL
  // minting inside the deployed workflow runtime resolves a routable path
  // when a multi-agent host proxies the agent behind a prefix.
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
    functions: { runtime: "nodejs24.x" },
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
