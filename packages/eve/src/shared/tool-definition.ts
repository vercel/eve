import type { ToolExecutionOptions } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Options forwarded from the AI SDK to the tool's {@link ToolDefinition.execute}
 * function. These are the same options the SDK passes to every tool call.
 */
export type ToolExecuteOptions = Omit<ToolExecutionOptions<unknown>, "context">;

export type ToolExecuteFn<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  options: ToolExecuteOptions,
) => Promise<TOutput> | TOutput;

interface ToolDefinitionBase {
  readonly description: string;
}

/**
 * Internal/compiled tool definition shape. Carries `name` because the
 * compiler stamps a path-derived identifier onto every tool entry.
 *
 * Authored public definitions (see {@link PublicToolDefinition}) do not
 * carry `name`; identity comes from the file path.
 */
export interface InternalToolDefinition extends ToolDefinitionBase {
  name: string;
  inputSchema: JsonObject | null;
  outputSchema?: JsonObject;
}

export type PublicToolInputSchema<TInput = unknown> =
  | StandardJSONSchemaV1<unknown, TInput>
  | JsonObject;

export type PublicToolOutputSchema<TOutput = unknown> =
  | StandardJSONSchemaV1<unknown, TOutput>
  | JsonObject;

/**
 * Authored public tool definition shape. Identity is derived from the
 * file path at compile time, so `name` is intentionally absent here.
 */
export interface PublicToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends ToolDefinitionBase {
  inputSchema: PublicToolInputSchema<TInput>;
  /**
   * Optional schema describing the value returned by the tool executor.
   * The AI SDK can use this for tool result typing.
   */
  outputSchema?: PublicToolOutputSchema<TOutput>;
}

export interface InternalToolDefinitionWithExecuteFn<
  TInput = unknown,
  TOutput = unknown,
> extends InternalToolDefinition {
  execute: ToolExecuteFn<TInput, TOutput>;
}

export interface PublicToolDefinitionWithExecuteFn<
  TInput = unknown,
  TOutput = unknown,
> extends PublicToolDefinition<TInput, TOutput> {
  execute: ToolExecuteFn<TInput, TOutput>;
}

/**
 * eve-owned shape for the model-facing tool result produced by
 * `toModelOutput`. Structurally compatible with the AI SDK's
 * `ToolResultOutput` so the harness can forward it without conversion.
 */
export type ToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: unknown };
