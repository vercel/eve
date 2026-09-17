import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { ConnectionAuthDefinition, HeadersDefinition } from "#shared/connection-types.js";
import type { JsonObject } from "#shared/json.js";
import type { RemoteAgentUrl } from "#public/definitions/remote-agent.js";

/** An A2A 1.0 agent exposed to the parent as a background subagent. */
export interface A2AAgentDefinitionInput {
  /** Agent origin or a direct public Agent Card URL. Resolved at runtime. */
  readonly url: RemoteAgentUrl;
  readonly description: string;
  /** Shared outbound authorization, including Vercel Connect providers. */
  readonly auth?: ConnectionAuthDefinition;
  readonly headers?: HeadersDefinition;
  /** Exact additional origins an independently hosted Agent Card may advertise. */
  readonly allowedInterfaceOrigins?: readonly string[];
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
}
export interface A2AAgentDefinition extends A2AAgentDefinitionInput {
  readonly kind: "a2a";
}
/** Define an A2A subagent in `agent/subagents/<name>.ts`. Compilation never fetches its card. */
export function defineA2AAgent(input: A2AAgentDefinitionInput): A2AAgentDefinition {
  if (!input.description?.trim()) throw new Error("defineA2AAgent requires a description.");
  for (const origin of input.allowedInterfaceOrigins ?? []) {
    if (new URL(origin).origin !== origin)
      throw new Error(
        "allowedInterfaceOrigins must contain exact origins without paths or wildcards.",
      );
  }
  return { ...input, kind: "a2a" };
}
