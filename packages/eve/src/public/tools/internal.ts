import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Converter that strips internal identity fields from a framework
 * {@link ResolvedToolDefinition} so it can be re-exported as a public
 * {@link ToolDefinition}.
 *
 * Framework tools have the internal `(input) => output` signature.
 * The public {@link ToolDefinition.execute} expects `(input, ctx)`.
 * This wrapper bridges the gap — `ctx` is trailing and omitted.
 */
export function toPublicToolDefinition(definition: ResolvedToolDefinition): ToolDefinition {
  if (!definition.execute) {
    throw new Error(`Tool "${definition.name}" is client-side and cannot be re-exported publicly.`);
  }

  const internalExecute = definition.execute;
  const inputSchema = definition.inputSchema;
  const publicDefinition: ToolDefinition = {
    description: definition.description,
    execute: (input) => internalExecute(input),
    inputSchema: (inputSchema ?? {}) as unknown as StandardJSONSchemaV1<unknown>,
    outputSchema: definition.outputSchema,
  };

  if (definition.needsApproval !== undefined) {
    publicDefinition.needsApproval = definition.needsApproval;
  }

  return publicDefinition;
}
