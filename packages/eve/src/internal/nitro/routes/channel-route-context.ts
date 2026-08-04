import type { RouteHandlerArgs } from "#channel/routes.js";
import type { RunHandle, RunInput } from "#channel/types.js";

type AgentInfoRouteResponse = () => Promise<Response>;
export type RouteSessionCreator = (
  input: Omit<RunInput, "adapter" | "channelName" | "requestId">,
) => Promise<RunHandle>;

const agentInfoRouteResponseKey = "__eveAgentInfoRouteResponse";
const routeSessionCreatorKey = "__eveRouteSessionCreator";

type InternalRouteArgs = RouteHandlerArgs & {
  [agentInfoRouteResponseKey]?: AgentInfoRouteResponse;
  [routeSessionCreatorKey]?: RouteSessionCreator;
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

export function attachRouteSessionCreator<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  createSession: RouteSessionCreator,
): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[routeSessionCreatorKey] = createSession;
  return args;
}

export function readRouteSessionCreator(args: RouteHandlerArgs): RouteSessionCreator | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[routeSessionCreatorKey];
}
