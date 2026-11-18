import type { SessionContext } from "#context/session-context.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";

interface MockToolInput {
  readonly label?: ResolvedToolDefinition["label"];
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject | null;
  readonly execute?: (input: unknown, ctx: SessionContext) => Promise<unknown> | unknown;
  readonly logicalPath?: string;
}

export function mockTool(input: MockToolInput): ResolvedToolDefinition {
  const logicalPath = input.logicalPath ?? `tools/${sanitizeLogicalPathSegment(input.name)}.ts`;
  const definition: ResolvedToolDefinition = {
    label: input.label,
    description: input.description ?? `${input.name} mock tool.`,
    inputSchema: toInputSchema(input.inputSchema ?? null),
    logicalPath,
    name: input.name,
    owner: { kind: "application" },
    sourceId: logicalPath,
    sourceKind: "module",
  };

  if (input.execute === undefined) {
    return definition;
  }

  const authoredExecute = input.execute;

  return {
    ...definition,
    execute: (rawInput) => authoredExecute(rawInput, buildCallbackContext()),
  };
}

function sanitizeLogicalPathSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}
