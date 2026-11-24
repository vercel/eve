import type { HeadersValue } from "#client/types.js";
import { builtInPlatform } from "#platform/context.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import {
  defineRemoteAgent,
  type RemoteAgentDefinition,
  type RemoteAgentUrl,
} from "#public/definitions/remote-agent.js";
import { normalizePublicRoutePrefix } from "#shared/public-route-prefix.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";

const WORKSPACE_AGENT_NAME = Symbol.for("eve.workspace-agent.name");

type BrandedWorkspaceSubagent = RemoteAgentDefinition & {
  readonly [WORKSPACE_AGENT_NAME]: string;
};

/** Runtime transport for one workspace peer. */
export interface WorkspaceAgentTransport {
  readonly auth?: OutboundAuthFn;
  readonly headers?: HeadersValue;
  readonly url: RemoteAgentUrl;
}

/** A workspace peer exposed as one remote subagent. */
export interface WorkspaceAgentDefinition {
  /** Overrides the peer agent's description in the parent's tool definition. */
  readonly description?: string;
  readonly forwardPrincipal?: boolean;
  /** Name of the peer workspace member, such as `research`. */
  readonly name: string;
  /**
   * How eve exposes this workspace peer to the parent model: `true` lists it
   * as a tool, `"deferred"` makes it a catalog entry the model finds with
   * `eve__search` and calls with `eve__tool`, and `false` keeps it callable only from
   * workflow tools. Defaults to `true`.
   */
  readonly tool?: AgentToolExposure;
  /** Overrides environment-aware workspace routing and service authentication. */
  readonly transport?: WorkspaceAgentTransport;
}

/** Defines one workspace peer as a remote subagent. */
export function defineWorkspaceAgent(definition: WorkspaceAgentDefinition): RemoteAgentDefinition {
  const transport = definition.transport ?? defaultWorkspaceAgentTransport(definition.name);
  const remote = defineRemoteAgent({
    auth: transport.auth,
    description: definition.description ?? "",
    forwardPrincipal: definition.forwardPrincipal,
    headers: transport.headers,
    tool: definition.tool,
    url: transport.url,
  }) as BrandedWorkspaceSubagent;
  Object.defineProperty(remote, WORKSPACE_AGENT_NAME, { value: definition.name });
  return remote;
}

export function workspaceSubagentName(value: unknown): string | undefined {
  return isBrandedWorkspaceSubagent(value) ? value[WORKSPACE_AGENT_NAME] : undefined;
}

function isBrandedWorkspaceSubagent(value: unknown): value is BrandedWorkspaceSubagent {
  return typeof value === "object" && value !== null && Reflect.has(value, WORKSPACE_AGENT_NAME);
}

function workspaceAgentRoutePrefix(name: string): string {
  const callerRoutePrefix = normalizePublicRoutePrefix(process.env.EVE_PUBLIC_ROUTE_PREFIX);
  const namespace =
    callerRoutePrefix?.slice(0, callerRoutePrefix.lastIndexOf("/")) ??
    (builtInPlatform().deployment.environment() === "development" ? "" : "/eve");
  return `${namespace}/${name}`;
}

function defaultWorkspaceAgentTransport(name: string): WorkspaceAgentTransport {
  const platformTransport = (): WorkspaceAgentTransport => {
    const transport = builtInPlatform().network.peer?.(workspaceAgentRoutePrefix(name));
    if (transport !== undefined) return transport;
    throw new Error(
      "No default workspace-agent transport is available in this environment. Provide transport to defineWorkspaceAgent().",
    );
  };
  return {
    auth: async () => {
      const auth = platformTransport().auth;
      return auth === undefined ? { headers: {} } : await auth();
    },
    url: () => {
      const url = platformTransport().url;
      return typeof url === "string" ? url : url();
    },
  };
}
