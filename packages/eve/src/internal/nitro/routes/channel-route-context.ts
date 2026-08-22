import type { RouteHandlerArgs } from "#channel/routes.js";
import type { RunHandle, RunInput } from "#channel/types.js";

type AgentInfoRouteResponse = () => Promise<Response>;
/**
 * Creates one session from a route handler. `continuationToken` is
 * channel-local (the dispatcher prepends the channel name), so ownership
 * established here is visible to `resolveSession` on the same channel.
 */
export type RouteSessionCreator = (
  input: Omit<RunInput, "adapter" | "channelName" | "requestId">,
) => Promise<RunHandle>;

export type RemoteAgentStreamHeadersResolver = (input: {
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
}) => Promise<Record<string, string>>;

const agentInfoRouteResponseKey = "__eveAgentInfoRouteResponse";
const routeChannelNameKey = "__eveRouteChannelName";
const remoteAgentStreamHeadersResolverKey = "__eveRemoteAgentStreamHeadersResolver";
const routeSessionCreatorKey = "__eveRouteSessionCreator";

type InternalRouteArgs = RouteHandlerArgs & {
  [agentInfoRouteResponseKey]?: AgentInfoRouteResponse;
  [routeChannelNameKey]?: string;
  [remoteAgentStreamHeadersResolverKey]?: RemoteAgentStreamHeadersResolver;
  [routeSessionCreatorKey]?: RouteSessionCreator;
};

export function attachRouteChannelName<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  channelName: string,
): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[routeChannelNameKey] = channelName;
  return args;
}

export function readRouteChannelName(args: RouteHandlerArgs): string | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[routeChannelNameKey];
}

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

export function attachRemoteAgentStreamHeadersResolver<TArgs extends RouteHandlerArgs>(
  args: TArgs,
  resolve: RemoteAgentStreamHeadersResolver,
): TArgs {
  const routeArgs: InternalRouteArgs = args;
  routeArgs[remoteAgentStreamHeadersResolverKey] = resolve;
  return args;
}

export function readRemoteAgentStreamHeadersResolver(
  args: RouteHandlerArgs,
): RemoteAgentStreamHeadersResolver | undefined {
  const routeArgs: InternalRouteArgs = args;
  return routeArgs[remoteAgentStreamHeadersResolverKey];
}
