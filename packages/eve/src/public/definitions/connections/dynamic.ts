import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import type { OpenAPIConnectionDefinition } from "#public/definitions/connections/openapi.js";
import {
  DYNAMIC_SENTINEL_KIND,
  type DynamicResolveContext,
  type DynamicSentinel,
} from "#dynamic/definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

/** One connection returned by a dynamic connection resolver. */
export type DynamicConnectionDefinition =
  | McpClientConnectionDefinition
  | OpenAPIConnectionDefinition;

/** A runtime connection set whose keys become connection names. */
export type DynamicConnectionSet = Readonly<Record<string, DynamicConnectionDefinition>>;

/** Supported return value for a dynamic connection resolver. */
export type DynamicConnectionResult = DynamicConnectionDefinition | DynamicConnectionSet | null;

/** Trusted session identity and minimal channel metadata available to connection resolvers. */
export interface DynamicConnectionResolveContext {
  readonly session: DynamicResolveContext["session"];
  readonly channel: Pick<DynamicResolveContext["channel"], "kind">;
}

/** Session and turn handlers supported by dynamic connections. */
export type DynamicConnectionEvents = {
  readonly [K in "session.started" | "turn.started"]?: (
    event: unknown,
    ctx: DynamicConnectionResolveContext,
  ) => DynamicConnectionResult | Promise<DynamicConnectionResult>;
};

/** Defines a runtime connection resolver for session and turn boundaries. */
export function defineDynamic<const TEvents extends DynamicConnectionEvents>(definition: {
  readonly events: ExactDefinition<TEvents, DynamicConnectionEvents>;
}): DynamicSentinel<DynamicConnectionResult> {
  const sentinel = {
    kind: DYNAMIC_SENTINEL_KIND,
    events: definition.events,
  } as DynamicSentinel<DynamicConnectionResult>;
  stampDefinitionKey(sentinel, `dynamic-connections:${Object.keys(definition.events).join(",")}`);
  return sentinel;
}
