import type { CompileFromMemoryToolInput } from "#compiler/compile-from-memory.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { PublicToolInputSchema, PublicToolOutputSchema } from "#shared/tool-definition.js";

/**
 * Declarative authored tool input for the in-memory AppHarness.
 */
export interface MockToolInput {
  /** Tool name exposed to the model and used for `tools/<name>.ts`. */
  readonly name: string;
  /** Human-readable description surfaced in the prompt. */
  readonly description?: string;
  /** Authored callback, invoked with the same public context as a filesystem tool. */
  readonly execute?: (
    input: unknown,
    ctx: ToolContext,
  ) => Promise<unknown> | unknown | AsyncIterable<unknown>;
  /** Optional authored input schema. */
  readonly inputSchema?: PublicToolInputSchema | null;
  /** Optional authored output schema. */
  readonly outputSchema?: PublicToolOutputSchema;
}

/** Builds one ordinary in-memory `tools/<name>.ts` source descriptor. */
export function mockTool(input: MockToolInput): CompileFromMemoryToolInput {
  const definition: {
    description: string;
    execute?: NonNullable<MockToolInput["execute"]>;
    inputSchema: PublicToolInputSchema | null;
    name: string;
    outputSchema?: PublicToolOutputSchema;
  } = {
    description: input.description ?? `${input.name} mock tool.`,
    inputSchema: input.inputSchema ?? null,
    name: input.name,
  };
  if (input.execute !== undefined) definition.execute = input.execute;
  if (input.outputSchema !== undefined) definition.outputSchema = input.outputSchema;
  return definition;
}
