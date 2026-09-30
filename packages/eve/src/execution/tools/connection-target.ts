/** The `connection_execute` call target, shared by execution and approval. */

import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";

export const CONNECTION_EXECUTE_TOOL_NAME = "connection_execute";

export interface ExecuteTarget {
  readonly connection: string;
  readonly input: JsonObject;
  readonly tool: string;
}

export function readExecuteTarget(value: unknown): ExecuteTarget | undefined {
  if (!isObject(value)) return undefined;
  const { connection, input, tool } = value;
  if (typeof connection !== "string" || typeof tool !== "string") return undefined;
  return { connection, input: isObject(input) ? (input as JsonObject) : {}, tool };
}

export function qualifiedToolName(target: Pick<ExecuteTarget, "connection" | "tool">): string {
  return `${target.connection}__${target.tool}`;
}

export function findConnection(
  registry: ConnectionRegistry,
  name: string,
): ResolvedConnectionDefinition | undefined {
  return registry.getConnections().find((connection) => connection.connectionName === name);
}
