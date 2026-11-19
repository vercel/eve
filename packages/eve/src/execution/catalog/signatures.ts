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
