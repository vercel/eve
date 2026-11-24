import { EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV } from "#internal/application/build-output-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";
import type { HostRouteVercelFunction } from "#internal/nitro/host/host-routes.js";
import type { PlatformNitroOptionsInput } from "#platform/types.js";
import { createEveScheduleQueueTrigger } from "#platform/vercel/schedules/routing.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/flow-route.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export { EVE_WORKFLOW_FLOW_ROUTE_PATH };

type FunctionRule = {
  environment: Record<string, string>;
  experimentalTriggers?: ReturnType<(typeof QUEUE_TRIGGERS)[HostRouteVercelFunction]>[];
  maxDuration?: "max";
};

export const VERCEL_SCHEDULES_FUNCTION_ROUTE = "/_vercel/tasks";

const QUEUE_TRIGGERS = {
  "workflow-queue": createEveWorkflowQueueTrigger,
  "schedule-queue": createEveScheduleQueueTrigger,
} satisfies Record<HostRouteVercelFunction, (agentName: string) => object>;

export function createEveVercelOptions(input: PlatformNitroOptionsInput) {
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

  const functionRules: Record<string, FunctionRule> = Object.fromEntries([
    ...Object.entries(QUEUE_TRIGGERS).flatMap(([vercelFunction, createTrigger]) =>
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
    ...(input.routeTable.scheduleTasks.length > 0
      ? [[VERCEL_SCHEDULES_FUNCTION_ROUTE, { environment }]]
      : []),
  ]);

  const schedules = Object.fromEntries(
    input.routeTable.scheduleTasks
      .filter((task) => task.timezone !== undefined)
      .map((task) => [
        task.nitroTaskName,
        {
          schedule: task.cron,
          timezone: task.timezone,
          function: VERCEL_SCHEDULES_FUNCTION_ROUTE.slice(1),
        },
      ]),
  );

  return {
    config: {
      version: 3 as const,
      ...(Object.keys(schedules).length > 0 && { schedules }),
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    },
    schedules: "private" as const,
    functionRules,
  };
}
