import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { HeadersValue } from "#client/types.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import { EVE_CREATE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Base URL of a remote eve deployment, either a static string or a function
 * resolved at runtime. Use the function form to read `process.env` for a URL
 * known only once the deployment runs. A string is baked into the compiled
 * manifest; a function is invoked when the runtime resolves the agent graph.
 */
export type RemoteAgentUrl = string | (() => string | Promise<string>);

/**
 * Public definition for a remote eve agent. The compiler lowers it to a
 * subagent tool.
 */
export interface RemoteAgentDefinition {
  readonly auth?: OutboundAuthFn;
  /**
   * The parent agent reads this as the lowered subagent tool's description.
   */
  readonly description: string;
  readonly headers?: HeadersValue;
  readonly kind: "remote";
  /**
   * Optional structured return type the caller requires from the remote agent.
   * The compiler lowers it to JSON Schema and sends it on the remote
   * create-session request; the remote deployment enforces it like any
   * task-mode output schema.
   */
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
  /**
   * Route eve appends to `url` for the create-session request. Defaults to the
   * framework create-session route (`/eve/v1/session`).
   */
  readonly path: string;
  /**
   * Base URL of the remote eve deployment to call. Accepts a static string
   * (baked at compile time) or a function resolved at runtime — use the
   * function form to read a URL from `process.env`.
   */
  readonly url: RemoteAgentUrl;
}

/**
 * Authored input that {@link defineRemoteAgent} accepts. eve derives identity
 * from the file path under `agent/subagents/`; authored definitions do not
 * carry a `name` field.
 */
export type RemoteAgentDefinitionInput = Omit<RemoteAgentDefinition, "kind" | "path"> & {
  readonly path?: string;
};

/**
 * Defines a remote eve agent that the parent can call as a subagent tool. The
 * compiler lowers it at compile time from the file path under `agent/subagents/`.
 *
 * Stamps `kind: "remote"` and, when `path` is omitted, defaults it to the
 * framework create-session route (`/eve/v1/session`) on the target `url`.
 */
export function defineRemoteAgent(input: RemoteAgentDefinitionInput): RemoteAgentDefinition {
  return {
    ...input,
    kind: "remote",
    path: input.path ?? EVE_CREATE_SESSION_ROUTE_PATH,
  };
}
