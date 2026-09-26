import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import type { Approval } from "#approval/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import {
  stampToolDefinition,
  type PublicToolDefinition,
  type ToolContext,
  type ToolInputRequest,
  type ToolInputResponse,
} from "#tools/definition.js";
import type { ToolModelOutput } from "#tools/model-output.js";

export interface AgentInput {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

type JsonSchemaProperties = Readonly<Record<string, JsonObject>>;
type JsonSchemaRequiredKeys<
  TProperties extends JsonSchemaProperties,
  TRequired,
> = TRequired extends readonly string[] ? Extract<TRequired[number], keyof TProperties> : never;
type Simplify<TValue> = { [TKey in keyof TValue]: TValue[TKey] };
type JsonSchemaObjectOutput<TProperties extends JsonSchemaProperties, TRequired> = Simplify<
  {
    -readonly [TKey in JsonSchemaRequiredKeys<TProperties, TRequired>]-?: JsonSchemaOutput<
      TProperties[TKey]
    >;
  } & {
    -readonly [
      TKey in Exclude<keyof TProperties, JsonSchemaRequiredKeys<TProperties, TRequired>>
    ]?: JsonSchemaOutput<TProperties[TKey]>;
  }
>;

type JsonSchemaOutput<TSchema> = TSchema extends { readonly const: infer TValue }
  ? Extract<TValue, JsonValue>
  : TSchema extends { readonly enum: readonly (infer TValue)[] }
    ? Extract<TValue, JsonValue>
    : TSchema extends {
          readonly type: "object";
          readonly properties: infer TProperties extends JsonSchemaProperties;
          readonly required?: infer TRequired;
        }
      ? JsonSchemaObjectOutput<TProperties, TRequired>
      : TSchema extends {
            readonly type: "array";
            readonly items: infer TItems extends JsonObject;
          }
        ? JsonSchemaOutput<TItems>[]
        : TSchema extends { readonly type: "string" }
          ? string
          : TSchema extends { readonly type: "integer" | "number" }
            ? number
            : TSchema extends { readonly type: "boolean" }
              ? boolean
              : TSchema extends { readonly type: "null" }
                ? null
                : JsonValue;

export interface WorkflowAgentMetadata {
  readonly description: string;
}

/** Context capabilities available inside an authored `"use step"` helper. */
export type WorkflowStepToolContext = Pick<
  ToolContext,
  "session" | "toolName" | "getToken" | "requireAuth"
>;

interface WorkflowAgent {
  <const TOutputSchema extends JsonObject>(
    target: string,
    input: AgentInput & { readonly outputSchema: TOutputSchema },
  ): Promise<JsonSchemaOutput<TOutputSchema>>;
  (target: string, input: AgentInput): Promise<JsonValue>;
}

/** One call to a workflow tool, as `ctx.receive()` resolves it. */
export interface WorkflowToolCall<TInput = unknown> {
  /** The call's input, validated by the tool's `inputSchema`. */
  readonly input: TInput;
  /** Id of the call: the same `callId` carried by the call's stream events. */
  readonly callId: string;
  /**
   * Aborts when the call's work is cancelled. The signal is durable: it
   * survives replay, steps that receive it observe the abort, and the run
   * waits a grace period for the body to unwind through `finally`.
   */
  readonly abortSignal: AbortSignal;
}

/**
 * Context supplied to a workflow tool body. When passed directly to a step,
 * eve replaces it with {@link WorkflowStepToolContext}.
 */
export type WorkflowToolContext<TInput = unknown, TOutput = unknown> = Pick<
  ToolContext,
  "session" | "toolName" | "getToken" | "requireAuth"
> & {
  /** Invoke an agent by its invocation name. */
  agent: WorkflowAgent;
  /** Metadata for agents callable by this workflow, including hidden agents. */
  agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  /**
   * Ask the human on the session's channel; awaiting the answer suspends the
   * run. Throws once the call has been settled with {@link reply}.
   */
  ask(request: ToolInputRequest): PromiseLike<ToolInputResponse>;
  /**
   * Resolves with the tool's call. The call arrives with the run, so the
   * first `receive()` resolves at once; a second `receive()` throws.
   */
  receive(): Promise<WorkflowToolCall<TInput>>;
  /**
   * Settles the call with `output` without finishing the run, so the body can
   * clean up after replying. Returning settles the call only if it has no
   * reply yet; a later reply or return value is dropped.
   */
  reply(output: TOutput): void;
};

const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

/** A static tool whose executor runs as a durable workflow. Its executor must start with "use workflow". */
export interface WorkflowToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends PublicToolDefinition<TInput, TOutput> {
  readonly [WORKFLOW_TOOL_BRAND]: true;
  execute(ctx: WorkflowToolContext<TInput, TOutput>): Promise<TOutput> | AsyncIterable<TOutput>;
  approval?: Approval<unknown extends TInput ? Record<string, unknown> : TInput>;
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

type WorkflowReturn<T> = T extends AsyncIterable<infer Output> ? Output : Awaited<T>;
type Schema = StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>;
// `TOutput` types `ctx.reply()`. It can't be inferred from `TReturn`: `execute`'s
// parameter would then depend on its own return type.
type Definition<TInput, TReturn, TOutput = unknown> = Omit<
  WorkflowToolDefinition<TInput, WorkflowReturn<TReturn>>,
  typeof WORKFLOW_TOOL_BRAND | "execute"
> & {
  execute(ctx: WorkflowToolContext<TInput, TOutput>): TReturn;
};

export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | AsyncIterable<StandardJSONSchemaV1.InferOutput<TOutputSchema>>,
>(
  definition: Omit<
    Definition<
      StandardSchemaV1.InferOutput<TInputSchema>,
      TReturn,
      StandardJSONSchemaV1.InferOutput<TOutputSchema>
    >,
    "inputSchema" | "outputSchema"
  > & {
    inputSchema: TInputSchema;
    outputSchema: TOutputSchema;
  },
): WorkflowToolDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardJSONSchemaV1.InferOutput<TOutputSchema>
>;
export function defineWorkflowTool<
  TSchema extends Schema,
  TReturn extends Promise<unknown> | AsyncIterable<unknown>,
>(
  definition: Omit<Definition<StandardSchemaV1.InferOutput<TSchema>, TReturn>, "inputSchema"> & {
    inputSchema: TSchema;
  },
): WorkflowToolDefinition<StandardSchemaV1.InferOutput<TSchema>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TReturn extends Promise<unknown> | AsyncIterable<unknown>>(
  definition: Definition<Record<string, unknown>, TReturn> & { inputSchema: JsonObject },
): WorkflowToolDefinition<Record<string, unknown>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TInput = unknown, TOutput = unknown>(
  definition: Omit<WorkflowToolDefinition<TInput, TOutput>, typeof WORKFLOW_TOOL_BRAND>,
): WorkflowToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput, TOutput>(
  definition: Omit<WorkflowToolDefinition<TInput, TOutput>, typeof WORKFLOW_TOOL_BRAND>,
): WorkflowToolDefinition<TInput, TOutput> {
  if ("execution" in definition) {
    throw new Error('"execution" was removed; workflow tool calls now block until they settle.');
  }
  stampToolDefinition(definition, "defineWorkflowTool");
  return Object.assign(definition, { [WORKFLOW_TOOL_BRAND]: true as const });
}

export function isWorkflowToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, WORKFLOW_TOOL_BRAND) === true
  );
}
