import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { HeadersValue } from "#client/types.js";
import { type OutboundAuthFn, vercelOidc } from "#public/agents/auth.js";
import {
  defineRemoteAgent,
  type RemoteAgentDefinition,
  type RemoteAgentUrl,
} from "#public/definitions/remote-agent.js";
import type { JsonObject } from "#shared/json.js";

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
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
  /** Name of the peer workspace member, such as `research`. */
  readonly name: string;
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
    outputSchema: definition.outputSchema,
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

function defaultWorkspaceAgentTransport(name: string): WorkspaceAgentTransport {
  const auth = vercelOidc();
  return {
    auth: async () => {
      requireVercelWorkspaceEnvironment();
      return auth();
    },
    url: () => {
      requireVercelWorkspaceEnvironment();
      const host =
        process.env.VERCEL_ENV === "production"
          ? process.env.VERCEL_PROJECT_PRODUCTION_URL
          : process.env.VERCEL_URL;
      if (host === undefined || host.length === 0) {
        throw new Error(
          "The default workspace-agent transport requires VERCEL_URL, or VERCEL_PROJECT_PRODUCTION_URL in production.",
        );
      }
      return `https://${host}/${name}`;
    },
  };
}

function requireVercelWorkspaceEnvironment(): void {
  if (process.env.VERCEL) return;
  throw new Error(
    "No default workspace-agent transport is available in this environment. Provide transport to defineWorkspaceAgent().",
  );
}
