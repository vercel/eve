import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import type { OpenAPIConnectionDefinition } from "#public/definitions/connections/openapi.js";
import {
  defineDynamic as defineDynamicDefinition,
  type DefineDynamic,
} from "#dynamic/definition.js";

/** One connection returned by a dynamic connection resolver. */
export type DynamicConnectionDefinition =
  | McpClientConnectionDefinition
  | OpenAPIConnectionDefinition;

/** A runtime connection set whose keys become connection names. */
export type DynamicConnectionSet = Readonly<Record<string, DynamicConnectionDefinition>>;

/** Supported return value for a dynamic connection resolver. */
export type DynamicConnectionResult = DynamicConnectionDefinition | DynamicConnectionSet | null;

/** `defineDynamic()` for `agent/connections/`: one connection named after the file, or a map. */
export const defineDynamic: DefineDynamic<DynamicConnectionResult> = defineDynamicDefinition;
