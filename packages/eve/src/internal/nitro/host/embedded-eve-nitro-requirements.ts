import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
} from "#protocol/routes.js";
import {
  computeChannelRouteRegistrations,
  describeChannelNitroRouteResources,
} from "#internal/nitro/host/channel-routes.js";
import {
  createEveNitroFrameworkVirtualId,
  createEveNitroHandlerVirtualId,
} from "#internal/nitro/host/configure-nitro-routes.js";
import type { EmbeddedEveNitroRequirements } from "#internal/nitro/host/embedded-nitro-host-validation.js";
import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";

const WORKFLOW_ROUTE_PATH = "/.well-known/workflow/v1/flow";

/** Describes every route and runtime capability an embedded contribution owns. */
export function createEmbeddedEveNitroRequirements(
  contribution: EveNitroContribution,
): EmbeddedEveNitroRequirements {
  const routes: EmbeddedEveNitroRequirements["routes"][number][] = [];

  if (contribution.applicationRoutes) {
    for (const method of ["GET", "HEAD"] as const) {
      routes.push({
        method,
        route: EVE_HEALTH_ROUTE_PATH,
        virtualId: createEveNitroHandlerVirtualId(method, EVE_HEALTH_ROUTE_PATH),
      });
    }
    routes.push(
      ...describeChannelNitroRouteResources(
        computeChannelRouteRegistrations(contribution.preparedHost),
      ),
    );
  }

  if (contribution.mode === "development") {
    routes.push(
      {
        method: "GET",
        route: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
        virtualId: createEveNitroFrameworkVirtualId(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH),
      },
      {
        method: "POST",
        route: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
        virtualId: createEveNitroFrameworkVirtualId(EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN),
      },
    );
  }

  if (contribution.workflowRoutes) {
    routes.push({ route: WORKFLOW_ROUTE_PATH });
  }

  return {
    routes,
    schedules:
      contribution.applicationRoutes && contribution.preparedHost.scheduleRegistrations.length > 0,
    websocket: contribution.applicationRoutes && contribution.configDelta.features.websocket,
  };
}
