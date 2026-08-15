import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Converter that strips internal identity fields from a framework
 * {@link ResolvedToolDefinition} so it can be re-exported as a public
 * {@link ToolDefinition}.
 *
 * Framework tools have the internal `(input, options) => output` signature.
 * The public {@link ToolDefinition.execute} expects `(input, ctx)`.
 * This wrapper bridges the gap — the public `ctx` is mapped back onto the
 * internal execute options.
 */
export function toPublicToolDefinition(definition: ResolvedToolDefinition): ToolDefinition {
  if (!definition.execute) {
    throw new Error(`Tool "${definition.name}" is client-side and cannot be re-exported publicly.`);
  }

  const internalExecute = definition.execute;
  const publicDefinition: ToolDefinition = {
    description: definition.description,
    execute: (input, ctx) =>
      internalExecute(input, {
        abortSignal: ctx.abortSignal,
        // The public context carries no model history, so the bridged
        // options cannot reproduce the AI SDK's `messages`.
        messages: [],
        toolCallId: ctx.callId,
      }),
    inputSchema: definition.inputSchema ?? {},
    outputSchema: definition.outputSchema,
  };

  if (definition.approval !== undefined) {
    publicDefinition.approval = definition.approval;
  }

  return publicDefinition;
}
