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

/**
 * Input of one `ctx.agent` call. With `taskId`, the call sends to an idle
 * agent task this workflow's session started, instead of starting a new one.
 */
export interface AgentInput {
  readonly taskId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

/** Options for one `ctx.agent` call. */
export interface AgentOptions {
  /** Aborting it cancels the call's task, and the call rejects with the signal's reason. */
  readonly signal?: AbortSignal;
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
    options?: AgentOptions,
  ): Promise<JsonSchemaOutput<TOutputSchema>>;
  (target: string, input: AgentInput, options?: AgentOptions): Promise<JsonValue>;
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

/**
 * Context supplied to a `resumable: true` workflow tool body. Each piece of
 * work on the task is a generation: the call that starts the task starts the
 * first, and each send, a call to the tool with the task's `taskId`, starts
 * or joins the next. `callId`, `session.turn`, `abortSignal`, and `ask`
 * follow the current generation.
 */
export type ResumableWorkflowToolContext<TInput, TOutput> = WorkflowToolContext & {
  /**
   * The next input sent with this task's `taskId`, typed by `inputSchema`.
   * Racing it against the current work takes a correction into that work;
   * after `reply`, it waits while the task is idle, and the input starts the
   * next generation. Input the body does not read is returned by its next
   * `receive()`. After `abortSignal` aborts, input waits for a `receive()`
   * called after the abort, which settles the stopped generation as
   * cancelled; a pending one the body started before the abort takes none
   * until then. Rejects once the task has ended.
   */
  receive(): Promise<TInput>;
  /**
   * Settles the current generation with its one result, typed like the
   * tool's output; `toModelOutput` applies. A second reply before the next
   * input throws. Replying ends the generation, so eve first cancels the tasks
   * it still owns, such as an un-awaited `ctx.agent` call, and `ctx.agent`
   * and `ctx.ask` throw until the body reads again.
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
  execute(input: TInput, ctx: WorkflowToolContext): Promise<TOutput> | AsyncIterable<TOutput>;
  approval?: Approval<unknown extends TInput ? Record<string, unknown> : TInput>;
  /**
   * `true` keeps the call attached to its turn: the turn holds the call, its
   * result is the tool result, and a steering message cancels it. Defaults
   * to `false`: the call starts a detached task and returns a receipt at
   * once; the task keeps working when a new message arrives, and the model
   * gets its result from `task_wait` or in a later task result message.
   */
  attached?: boolean;
  /**
   * `true` lets the task take more input: calling the tool again with the
   * task's `taskId` sends that input to the running body, which reads it with
   * `ctx.receive()` and settles each piece of work with `ctx.reply()` (see
   * {@link ResumableWorkflowToolContext}). Returning from `execute` ends the
   * task. Defaults to `false`. A resumable task stays available across turns,
   * so it cannot be `attached`.
   */
  resumable?: boolean;
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

/** Validates an authored `resumable` value, which cannot be combined with `attached: true`. */
export function normalizeWorkflowToolResumable(
  definition: { readonly attached?: unknown; readonly resumable?: unknown },
  factory: string,
): boolean | undefined {
  const { resumable } = definition;
  if (resumable !== undefined && typeof resumable !== "boolean") {
    throw new Error(
      `${factory}: "resumable" must be true or false, received ${describe(resumable)}.`,
    );
  }
  if (resumable === true && definition.attached === true) {
    throw new Error(
      `${factory}: "resumable" cannot be combined with "attached". A resumable task stays available across turns, so it cannot hold one; remove "attached".`,
    );
  }
  return resumable;
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
  typeof WORKFLOW_TOOL_BRAND | "execute" | "resumable"
> & {
  execute(input: TInput, ctx: WorkflowToolContext): TReturn;
  resumable?: false;
};
/**
 * A resumable body replies to each generation; after a reply, it ends with a
 * bare `return`. A generator body's yields are progress for the current
 * generation, never a result.
 */
type ResumableDefinition<TInput, TOutput> = Omit<
  WorkflowToolDefinition<TInput, TOutput>,
  typeof WORKFLOW_TOOL_BRAND | "attached" | "execute" | "resumable"
> & {
  resumable: true;
  attached?: false;
  execute(
    input: TInput,
    ctx: ResumableWorkflowToolContext<TInput, TOutput>,
  ): Promise<TOutput | undefined> | AsyncGenerator<unknown, TOutput | void>;
};

export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(
  definition: Omit<
    ResumableDefinition<
      StandardSchemaV1.InferOutput<TInputSchema>,
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
export function defineWorkflowTool<TSchema extends Schema, TOutput = JsonValue>(
  definition: Omit<
    ResumableDefinition<StandardSchemaV1.InferOutput<TSchema>, TOutput>,
    "inputSchema"
  > & {
    inputSchema: TSchema;
  },
): WorkflowToolDefinition<StandardSchemaV1.InferOutput<TSchema>, TOutput>;
export function defineWorkflowTool<TOutput = JsonValue>(
  definition: ResumableDefinition<Record<string, unknown>, TOutput> & { inputSchema: JsonObject },
): WorkflowToolDefinition<Record<string, unknown>, TOutput>;

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
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>> & { resumable?: false },
): WorkflowToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput, TOutput>(
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>>,
): WorkflowToolDefinition<TInput, TOutput> {
  rejectRemovedExecutionOption(definition, "defineWorkflowTool");
  normalizeWorkflowToolAttached(definition.attached, "defineWorkflowTool");
  normalizeWorkflowToolResumable(definition, "defineWorkflowTool");
  normalizeTaskTimeout(definition.timeout, "defineWorkflowTool:");
  stampToolDefinition(definition, "defineWorkflowTool");
  return Object.assign(definition, { [WORKFLOW_TOOL_BRAND]: true as const });
}

export function isWorkflowToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, WORKFLOW_TOOL_BRAND) === true
  );
}
