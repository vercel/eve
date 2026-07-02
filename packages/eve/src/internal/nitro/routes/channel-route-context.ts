import type { RouteHandlerArgs } from "#channel/routes.js";

type AgentInfoRouteResponse = () => Promise<Response>;

const agentInfoRouteResponseKey = "__eveAgentInfoRouteResponse";

type AgentInfoRouteArgs = RouteHandlerArgs & {
  [agentInfoRouteResponseKey]?: AgentInfoRouteResponse;
};

export function attachAgentInfoRouteResponse<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  respond: AgentInfoRouteResponse,
): TArgs {
  const routeArgs: AgentInfoRouteArgs = args;
  routeArgs[agentInfoRouteResponseKey] = respond;
  return args;
}

export function readAgentInfoRouteResponse(
  args: RouteHandlerArgs,
): AgentInfoRouteResponse | undefined {
  const routeArgs: AgentInfoRouteArgs = args;
  return routeArgs[agentInfoRouteResponseKey];
}
