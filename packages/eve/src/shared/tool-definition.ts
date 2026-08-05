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
) => Promise<TOutput> | TOutput | AsyncIterable<TOutput>;

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
 *
 * The `content` variant carries an ordered list of
 * {@link ToolModelOutputPart} entries, letting a tool hand the model
 * text alongside inline files (e.g. a screenshot as vision input).
 */
export type ToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "content"; readonly value: readonly ToolModelOutputPart[] };

/**
 * One part of a `content` {@link ToolModelOutput}. Mirrors the AI SDK's
 * `ToolResultOutput` content parts narrowed to the JSON-safe subset:
 * file data is the SDK's tagged `FileData` union restricted to
 * `{ type: "data" }` with a base64 string, so persisted tool results
 * survive the durable JSON boundary. Use the `toolOutputPart` builders
 * from `eve/tools` to construct parts without hand-writing the nesting.
 */
export type ToolModelOutputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      /** Tagged file data; only JSON-safe base64 payloads are accepted. */
      readonly data: { readonly type: "data"; readonly data: string };
      /** IANA media type, e.g. `image/png`. */
      readonly mediaType: string;
      readonly filename?: string;
    };
