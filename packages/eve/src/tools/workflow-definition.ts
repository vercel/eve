import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import type { Approval } from "#approval/definition.js";
import type { MessageResult, SendTurnOptions } from "#client/types.js";
import type { JsonObject } from "#shared/json.js";
import {
  stampToolDefinition,
  type PublicToolDefinition,
  type ToolContext,
  type ToolInputRequest,
  type ToolInputRequestOptions,
  type ToolInputResponse,
} from "#tools/definition.js";
import type { ToolModelOutput } from "#tools/model-output.js";
import {
  WORKFLOW_TOOL_ENTRY_POINTS,
  type WorkflowToolEntryPoint,
} from "#tools/workflow-entry-point.js";

export type { WorkflowToolEntryPoint };

export interface WorkflowAgentMetadata {
  readonly description: string;
}

/** Context capabilities available inside an authored `"use step"` helper. */
export type WorkflowStepToolContext = Pick<
  ToolContext,
  "abortSignal" | "callId" | "session" | "toolName" | "getToken" | "requireAuth"
>;

/** Options for one message to a `ctx.agent` session. */
export interface AgentSendOptions<TOutput = unknown> {
  /** Structured output for the turn, as on the client's `send`. */
  readonly outputSchema?: SendTurnOptions<TOutput>["outputSchema"];
  /** Aborting cancels the turn this message started or joined; the turn still reports. */
  readonly signal?: AbortSignal;
}

/**
 * How one agent turn ended, as the client's `MessageResult` reports it:
 * `"waiting"` when the session waits for its next message, including after a
 * cancelled turn, which carries neither `data` nor `message`; `"completed"`
 * when the session ended with the turn; and `"failed"` when the turn failed.
 */
export type AgentMessageResult<TOutput = unknown> = Pick<
  MessageResult<TOutput>,
  "data" | "message" | "status"
>;

/** The response to one message sent to a `ctx.agent` session. */
export interface AgentResponse<TOutput = unknown> {
  /** Resolves when the turn the message started or joined ends. */
  result(): Promise<AgentMessageResult<TOutput>>;
}

/**
 * A session the workflow run owns, opened by its first `send` and ended when
 * the run finishes. Only the run can address it.
 */
export interface AgentSession {
  /**
   * Delivers a message. It joins the session's running turn, whose result the
   * response resolves, or starts the next turn when the session is idle or the
   * running turn ends before the agent reads it.
   */
  send<TOutput = unknown>(
    message: string,
    options?: AgentSendOptions<TOutput>,
  ): Promise<AgentResponse<TOutput>>;
}

/** Members the context of every workflow tool entry point shares. */
export type WorkflowSharedContext = Pick<
  ToolContext,
  "session" | "toolName" | "getToken" | "requireAuth"
> & {
  /**
   * Returns a new session with the agent of this invocation name. Nothing
   * starts until the first `send`.
   */
  agent(name: string): AgentSession;
  /** Metadata for agents callable by this workflow, including hidden agents. */
  agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  /**
   * Ask the human on the session's channel; awaiting the answer suspends the
   * run. The request is withdrawn, resolving as `cancelled`, when
   * `options.signal` or the call's `abortSignal` aborts.
   */
  ask(request: ToolInputRequest, options?: ToolInputRequestOptions): PromiseLike<ToolInputResponse>;
};

/**
 * Context of an `execute(input, ctx)` call, which the turn waits on. When
 * passed directly to a step, eve replaces it with {@link WorkflowStepToolContext}.
 */
export type WorkflowToolContext = WorkflowSharedContext &
  Pick<ToolContext, "abortSignal" | "callId"> & {
    /**
     * Aborts once, on the first steering message that arrives while the turn
     * waits on this call. What it means is the tool's choice: a body that
     * ignores it keeps going, and one that should stop early races or passes it.
     */
    readonly interruptSignal: AbortSignal;
  };

/**
 * Context of a `task(input, ctx)` call, which runs as a task. Steering never
 * interrupts a task, so it has no `interruptSignal`. When passed directly to a
 * step, eve replaces it with {@link WorkflowStepToolContext}.
 */
export type WorkflowTaskContext = WorkflowSharedContext &
  Pick<ToolContext, "abortSignal" | "callId">;

/**
 * One call a `serve` body receives: the call that started the task, or a
 * later call the model made with the task's `taskId`.
 */
export interface WorkflowServeCall<TInput = unknown> {
  readonly callId: string;
  /** The call's input, validated by the tool's `inputSchema`. */
  readonly input: TInput;
  /**
   * Aborts when the task's current stretch of work is cancelled or the
   * session ends. A stretch starts when a call reaches an idle task and ends
   * when a reply or a cancel settles its calls; calls that arrive during it
   * share its signal, and the next stretch gets a new one.
   */
  readonly abortSignal: AbortSignal;
}

/**
 * Resolves with the task's next call. The first `receive()` resolves at once
 * with the call that started the task; each later one with the next call made
 * with the task's `taskId`, in arrival order. A pending `receive()` is shared:
 * calling it again returns the same promise. It rejects when the session ends.
 */
export type WorkflowServeReceive<TInput = unknown> = () => Promise<WorkflowServeCall<TInput>>;

/**
 * Context of a `serve(receive, ctx)` task. Each call brings its own `callId`
 * and `abortSignal` from `receive()`, and steering never interrupts a task, so
 * the context has neither. `ctx.ask` throws while no call is waiting for a
 * result. When passed directly to a step, eve replaces it with
 * {@link WorkflowStepToolContext} for the latest call waiting for a result.
 */
export type WorkflowServeContext<TOutput = unknown> = WorkflowSharedContext & {
  /**
   * Settles every call received so far with `output`, and the task goes idle
   * until its next call. A reply with no call left to settle, including one
   * after a cancel, is dropped.
   */
  reply(output: TOutput): void;
};

const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

interface WorkflowToolDefinitionBase<TInput, TOutput> extends PublicToolDefinition<
  TInput,
  TOutput
> {
  readonly [WORKFLOW_TOOL_BRAND]: true;
  approval?: Approval<unknown extends TInput ? Record<string, unknown> : TInput>;
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

/** A workflow tool whose calls are ordinary tool calls: the turn waits until each settles. */
export interface WorkflowExecuteToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends WorkflowToolDefinitionBase<TInput, TOutput> {
  execute(input: TInput, ctx: WorkflowToolContext): Promise<TOutput> | AsyncIterable<TOutput>;
  task?: never;
  serve?: never;
}

/**
 * A workflow tool whose every call runs as a task: the model gets a receipt at
 * once and the conversation continues, and the result arrives later in a
 * `task.result` message.
 */
export interface WorkflowTaskToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends WorkflowToolDefinitionBase<TInput, TOutput> {
  task(input: TInput, ctx: WorkflowTaskContext): Promise<TOutput> | AsyncIterable<TOutput>;
  execute?: never;
  serve?: never;
}

/**
 * A workflow tool whose calls reach resumable tasks. A call without `taskId`
 * starts a task, whose body runs once and gets that call and every later call
 * made with its `taskId` from `receive()`; each `ctx.reply()` delivers a
 * result. eve adds the optional `taskId` to the tool's model input, so
 * `inputSchema` must not declare its own. Returning settles the calls still
 * waiting and ends the task; throwing fails them.
 */
export interface WorkflowServeToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends WorkflowToolDefinitionBase<TInput, TOutput> {
  serve(
    receive: WorkflowServeReceive<TInput>,
    ctx: WorkflowServeContext<TOutput>,
  ): Promise<TOutput>;
  execute?: never;
  task?: never;
}

/**
 * A static tool whose entry point runs as a durable workflow and must start
 * with "use workflow". It defines exactly one entry point.
 */
export type WorkflowToolDefinition<TInput = unknown, TOutput = unknown> =
  | WorkflowExecuteToolDefinition<TInput, TOutput>
  | WorkflowTaskToolDefinition<TInput, TOutput>
  | WorkflowServeToolDefinition<TInput, TOutput>;

type Unbranded<T> = T extends unknown ? Omit<T, typeof WORKFLOW_TOOL_BRAND> : never;
type WorkflowReturn<T> = T extends AsyncIterable<infer Output> ? Output : Awaited<T>;
type Schema = StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>;
type EntryPointReturn<TOutput> = Promise<TOutput> | AsyncIterable<TOutput>;
type InferOutput<TSchema extends StandardJSONSchemaV1<unknown, unknown>> =
  StandardJSONSchemaV1.InferOutput<TSchema>;
type InferInput<TSchema extends Schema> = StandardSchemaV1.InferOutput<TSchema>;

type DefinitionFields<TInput, TOutput> = Omit<
  WorkflowToolDefinitionBase<TInput, TOutput>,
  typeof WORKFLOW_TOOL_BRAND
>;
type ExecuteDefinition<TInput, TReturn> = DefinitionFields<TInput, WorkflowReturn<TReturn>> & {
  execute(input: TInput, ctx: WorkflowToolContext): TReturn;
  task?: never;
  serve?: never;
};
type TaskDefinition<TInput, TReturn> = DefinitionFields<TInput, WorkflowReturn<TReturn>> & {
  task(input: TInput, ctx: WorkflowTaskContext): TReturn;
  execute?: never;
  serve?: never;
};
// `ctx.reply()` needs the output type before the body is checked, so a serve
// tool's output comes from its `outputSchema`, not from what `serve` returns.
type ServeDefinition<TInput, TOutput> = DefinitionFields<TInput, TOutput> & {
  serve(
    receive: WorkflowServeReceive<TInput>,
    ctx: WorkflowServeContext<TOutput>,
  ): Promise<TOutput>;
  execute?: never;
  task?: never;
};
type WithSchemas<TDefinition, TInputSchema, TOutputSchema> = Omit<
  TDefinition,
  "inputSchema" | "outputSchema"
> & {
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
};
type WithInputSchema<TDefinition, TSchema> = Omit<TDefinition, "inputSchema"> & {
  inputSchema: TSchema;
};

// One overload per entry point and schema form. A single overload per form
// can't tell which entry point a definition uses: TypeScript neither infers it
// from the method a definition defines nor contextually types `toModelOutput`
// through a union of the three shapes.
export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends EntryPointReturn<InferOutput<TOutputSchema>>,
>(
  definition: WithSchemas<
    ExecuteDefinition<InferInput<TInputSchema>, TReturn>,
    TInputSchema,
    TOutputSchema
  >,
): WorkflowExecuteToolDefinition<InferInput<TInputSchema>, InferOutput<TOutputSchema>>;
export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends EntryPointReturn<InferOutput<TOutputSchema>>,
>(
  definition: WithSchemas<
    TaskDefinition<InferInput<TInputSchema>, TReturn>,
    TInputSchema,
    TOutputSchema
  >,
): WorkflowTaskToolDefinition<InferInput<TInputSchema>, InferOutput<TOutputSchema>>;
export function defineWorkflowTool<
  TInputSchema extends Schema,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(
  definition: WithSchemas<
    ServeDefinition<InferInput<TInputSchema>, InferOutput<TOutputSchema>>,
    TInputSchema,
    TOutputSchema
  >,
): WorkflowServeToolDefinition<InferInput<TInputSchema>, InferOutput<TOutputSchema>>;
export function defineWorkflowTool<
  TSchema extends Schema,
  TReturn extends EntryPointReturn<unknown>,
>(
  definition: WithInputSchema<ExecuteDefinition<InferInput<TSchema>, TReturn>, TSchema>,
): WorkflowExecuteToolDefinition<InferInput<TSchema>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<
  TSchema extends Schema,
  TReturn extends EntryPointReturn<unknown>,
>(
  definition: WithInputSchema<TaskDefinition<InferInput<TSchema>, TReturn>, TSchema>,
): WorkflowTaskToolDefinition<InferInput<TSchema>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TSchema extends Schema>(
  definition: WithInputSchema<ServeDefinition<InferInput<TSchema>, unknown>, TSchema>,
): WorkflowServeToolDefinition<InferInput<TSchema>>;
export function defineWorkflowTool<TReturn extends EntryPointReturn<unknown>>(
  definition: ExecuteDefinition<Record<string, unknown>, TReturn> & { inputSchema: JsonObject },
): WorkflowExecuteToolDefinition<Record<string, unknown>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TReturn extends EntryPointReturn<unknown>>(
  definition: TaskDefinition<Record<string, unknown>, TReturn> & { inputSchema: JsonObject },
): WorkflowTaskToolDefinition<Record<string, unknown>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool(
  definition: ServeDefinition<Record<string, unknown>, unknown> & { inputSchema: JsonObject },
): WorkflowServeToolDefinition<Record<string, unknown>>;
export function defineWorkflowTool<TInput = unknown, TOutput = unknown>(
  definition: Unbranded<WorkflowExecuteToolDefinition<TInput, TOutput>>,
): WorkflowExecuteToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput = unknown, TOutput = unknown>(
  definition: Unbranded<WorkflowTaskToolDefinition<TInput, TOutput>>,
): WorkflowTaskToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput = unknown, TOutput = unknown>(
  definition: Unbranded<WorkflowServeToolDefinition<TInput, TOutput>>,
): WorkflowServeToolDefinition<TInput, TOutput>;
export function defineWorkflowTool(
  definition: Unbranded<WorkflowToolDefinition>,
): WorkflowToolDefinition {
  if ("execution" in definition) {
    throw new Error(
      '"execution" was replaced by task(). Define task(input, ctx) to run each call as a task.',
    );
  }
  assertOneEntryPoint(definition);
  stampToolDefinition(definition, "defineWorkflowTool");
  return Object.assign(definition, { [WORKFLOW_TOOL_BRAND]: true as const });
}

export function isWorkflowToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, WORKFLOW_TOOL_BRAND) === true
  );
}

/** The entry points a definition defines; a workflow tool defines exactly one. */
export function readWorkflowToolEntryPoints(definition: object): WorkflowToolEntryPoint[] {
  return WORKFLOW_TOOL_ENTRY_POINTS.filter(
    (entryPoint) => Reflect.get(definition, entryPoint) !== undefined,
  );
}

const ENTRY_POINT_LIST = new Intl.ListFormat("en", { type: "conjunction" });

function assertOneEntryPoint(definition: object): void {
  const defined = readWorkflowToolEntryPoints(definition);
  if (defined.length === 1) return;
  const found = defined.length === 0 ? "none" : ENTRY_POINT_LIST.format(defined);
  throw new Error(
    `Define exactly one of execute(input, ctx), task(input, ctx), or serve(receive, ctx); this tool defines ${found}.`,
  );
}
