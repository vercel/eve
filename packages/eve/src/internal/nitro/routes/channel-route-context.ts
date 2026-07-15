import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Agent } from "#public/definitions/channel.js";

type AgentInfoRouteResponse = () => Promise<Response>;

const agentInfoRouteResponseKey = "__eveAgentInfoRouteResponse";
const routeAgentKey = "__eveRouteAgent";

type InternalRouteArgs = RouteHandlerArgs & {
  [agentInfoRouteResponseKey]?: AgentInfoRouteResponse;
  [routeAgentKey]?: Agent;
};

export function attachAgentInfoRouteResponse<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  respond: AgentInfoRouteResponse,
): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[agentInfoRouteResponseKey] = respond;
  return args;
}

export function readAgentInfoRouteResponse(
  args: RouteHandlerArgs,
): AgentInfoRouteResponse | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[agentInfoRouteResponseKey];
}

export function attachRouteAgent<TArgs extends RouteHandlerArgs>(args: TArgs, agent: Agent): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[routeAgentKey] = agent;
  return args;
}

export function readRouteAgent(args: RouteHandlerArgs): Agent | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[routeAgentKey];
}
