/** TypeScript signatures for catalog entries, rendered from the schemas each call sees. */

import { connectionToolName } from "#connections/ownership.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";
import { renderToolSignature } from "#tools/signature.js";

/**
 * An agent entry's signature, from the schemas the model would see for it.
 * A caller that already converted the input schema passes it in.
 */
export function entrySignature(
  definition: HarnessToolDefinition,
  inputSchema = serializeInputSchema(definition.inputSchema as ToolSchemaSource),
): string {
  return renderToolSignature({
    inputSchema,
    name: definition.name,
    outputSchema: serializeOutputSchema(definition.outputSchema as ToolSchemaSource | undefined),
  });
}

/** A connection tool's signature under its full name. */
export function connectionToolSignature(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
): string {
  return renderToolSignature({
    inputSchema: tool.inputSchema,
    name: connectionToolName(connection.connectionName, tool.name),
    outputSchema: tool.outputSchema,
  });
}
