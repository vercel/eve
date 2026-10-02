import type { RouteHandlerArgs } from "#channel/routes.js";

/** The agent route args, for tests whose routes never call them. */
export function mockAgentRouteArgs(): Pick<RouteHandlerArgs, "describe"> {
  return {
    describe: async () => {
      throw new Error("describe() is unavailable in this test.");
    },
  };
}
