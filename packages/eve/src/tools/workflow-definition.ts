import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import type { Approval } from "#approval/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { normalizeTaskTimeout } from "#shared/task-timeout.js";
import {
  rejectRemovedExecutionOption,
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
  "abortSignal" | "callId" | "session" | "toolName" | "getToken" | "requireAuth"
>;

interface WorkflowAgent {
  <const TOutputSchema extends JsonObject>(
    target: string,
    input: AgentInput & { readonly outputSchema: TOutputSchema },
  ): Promise<JsonSchemaOutput<TOutputSchema>>;
  (target: string, input: AgentInput): Promise<JsonValue>;
}

/**
 * Context supplied to a workflow tool body. When passed directly to a step,
 * eve replaces it with {@link WorkflowStepToolContext}.
 */
export type WorkflowToolContext = Pick<
  ToolContext,
  "abortSignal" | "callId" | "session" | "toolName" | "getToken" | "requireAuth"
> & {
  /** Invoke an agent by its invocation name. */
  agent: WorkflowAgent;
  /** Metadata for agents callable by this workflow, including hidden agents. */
  agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  /** Ask the human on the session's channel; awaiting the answer suspends the run. */
  ask(request: ToolInputRequest): PromiseLike<ToolInputResponse>;
};

const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

/** A static tool whose executor runs as a durable workflow. Its executor must start with "use workflow". */
export interface WorkflowToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends PublicToolDefinition<TInput, TOutput> {
  readonly [WORKFLOW_TOOL_BRAND]: true;
  execute(input: TInput, ctx: WorkflowToolContext): Promise<TOutput> | AsyncIterable<TOutput>;
  approval?: Approval<unknown extends TInput ? Record<string, unknown> : TInput>;
  /**
   * `true` keeps the call attached to its turn: its result is always the
   * tool result, and a steering message never moves it to the background.
   * Defaults to `false`: the call still waits, but in an interactive root
   * session (a root session in conversation mode) a steering message moves
   * it to the background, and its result arrives later as a task result.
   */
  attached?: boolean;
  /**
   * Time limit for each call, in milliseconds of active time: time the run
   * spends waiting on `ctx.ask` or an approval does not count. A call still
   * working at the limit fails with `TIMED_OUT`, and eve cancels the run.
   * Defaults to `false`: the session's lifetime is the only limit.
   */
  timeout?: number | false;
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

/** Validates an authored `attached` value. */
export function normalizeWorkflowToolAttached(
  value: unknown,
  factory: string,
): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new Error(`${factory}: "attached" must be true or false, received ${describe(value)}.`);
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type Unbranded<T> = T extends unknown ? Omit<T, typeof WORKFLOW_TOOL_BRAND> : never;
type WorkflowReturn<T> = T extends AsyncIterable<infer Output> ? Output : Awaited<T>;
type Schema = StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>;
type Definition<TInput, TReturn> = Omit<
  WorkflowToolDefinition<TInput, WorkflowReturn<TReturn>>,
  typeof WORKFLOW_TOOL_BRAND | "execute"
> & {
  execute(input: TInput, ctx: WorkflowToolContext): TReturn;
};

export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | AsyncIterable<StandardJSONSchemaV1.InferOutput<TOutputSchema>>,
>(
  definition: Omit<
    Definition<StandardSchemaV1.InferOutput<TInputSchema>, TReturn>,
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
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>>,
): WorkflowToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput, TOutput>(
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>>,
): WorkflowToolDefinition<TInput, TOutput> {
  rejectRemovedExecutionOption(definition, "defineWorkflowTool");
  normalizeWorkflowToolAttached(definition.attached, "defineWorkflowTool");
  normalizeTaskTimeout(definition.timeout, "defineWorkflowTool:");
  stampToolDefinition(definition, "defineWorkflowTool");
  return Object.assign(definition, { [WORKFLOW_TOOL_BRAND]: true as const });
}

export function isWorkflowToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, WORKFLOW_TOOL_BRAND) === true
  );
}
