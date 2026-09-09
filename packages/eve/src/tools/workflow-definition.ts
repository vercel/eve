import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import type { Approval } from "#approval/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import {
  stampToolDefinition,
  type PublicToolDefinition,
  type BackgroundToolDefinition,
  type ToolContext,
  type ToolInputRequest,
  type ToolInputResponse,
} from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import type { ToolModelOutput } from "#tools/model-output.js";

export interface AgentInput {
  readonly agentId?: string;
  readonly key: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
}

/**
 * Context supplied to a workflow tool. Pass it directly to a step helper for
 * getToken/requireAuth; those capabilities throw in the workflow body itself.
 */
export type WorkflowToolContext = Pick<
  ToolContext,
  "abortSignal" | "callId" | "session" | "toolName" | "getToken" | "requireAuth"
> & {
  /** Invoke a visible subagent. The key must be unique within this workflow run. */
  agent(input: AgentInput): Promise<JsonValue>;
  /** Ask the human on the session's channel; awaiting the answer suspends the run. */
  ask(request: ToolInputRequest): PromiseLike<ToolInputResponse>;
};

const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

/** A static tool whose executor runs as a durable workflow. Its executor must start with "use workflow". */
export interface BlockingWorkflowToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends PublicToolDefinition<TInput, TOutput> {
  readonly [WORKFLOW_TOOL_BRAND]: true;
  readonly execution?: never;
  execute(input: TInput, ctx: WorkflowToolContext): Promise<TOutput> | AsyncIterable<TOutput>;
  approval?: Approval<unknown extends TInput ? Record<string, unknown> : TInput>;
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

type BackgroundWorkflowToolDefinition<TInput, TOutput> = Omit<
  BackgroundToolDefinition<TInput, TOutput>,
  "execute"
> & {
  readonly [WORKFLOW_TOOL_BRAND]: true;
  execute(
    input: TInput,
    ctx: WorkflowToolContext,
    task: TaskExec,
  ): Promise<TOutput> | AsyncIterable<unknown>;
};

/** A static tool whose executor runs as a durable workflow. */
export type WorkflowToolDefinition<TInput = unknown, TOutput = unknown> =
  | BlockingWorkflowToolDefinition<TInput, TOutput>
  | BackgroundWorkflowToolDefinition<TInput, TOutput>;

type Unbranded<T> = T extends unknown ? Omit<T, typeof WORKFLOW_TOOL_BRAND> : never;
type BackgroundReturn<T> =
  T extends AsyncGenerator<unknown, infer Output>
    ? Output
    : T extends AsyncIterable<unknown>
      ? null
      : Awaited<T>;
type BackgroundDefinition<TInput, TReturn> = Omit<
  BackgroundWorkflowToolDefinition<TInput, BackgroundReturn<TReturn>>,
  typeof WORKFLOW_TOOL_BRAND | "execute"
> & {
  execute(input: TInput, ctx: WorkflowToolContext, task: TaskExec): TReturn;
};

type WorkflowReturn<T> = T extends AsyncIterable<infer Output> ? Output : Awaited<T>;
type Schema = StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>;
type Definition<TInput, TReturn> = Omit<
  BlockingWorkflowToolDefinition<TInput, WorkflowReturn<TReturn>>,
  typeof WORKFLOW_TOOL_BRAND | "execute"
> & {
  execute(input: TInput, ctx: WorkflowToolContext): TReturn;
};

export function defineWorkflowTool<
  TSchema extends Schema,
  TReturn extends Promise<unknown> | AsyncIterable<unknown>,
>(
  definition: Omit<
    BackgroundDefinition<StandardSchemaV1.InferOutput<TSchema>, TReturn>,
    "inputSchema"
  > & { inputSchema: TSchema },
): BackgroundWorkflowToolDefinition<
  StandardSchemaV1.InferOutput<TSchema>,
  BackgroundReturn<TReturn>
>;
export function defineWorkflowTool<TReturn extends Promise<unknown> | AsyncIterable<unknown>>(
  definition: BackgroundDefinition<Record<string, unknown>, TReturn> & { inputSchema: JsonObject },
): BackgroundWorkflowToolDefinition<Record<string, unknown>, BackgroundReturn<TReturn>>;
export function defineWorkflowTool<
  TSchema extends Schema,
  TReturn extends Promise<unknown> | AsyncIterable<unknown>,
>(
  definition: Omit<Definition<StandardSchemaV1.InferOutput<TSchema>, TReturn>, "inputSchema"> & {
    inputSchema: TSchema;
  },
): BlockingWorkflowToolDefinition<StandardSchemaV1.InferOutput<TSchema>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TReturn extends Promise<unknown> | AsyncIterable<unknown>>(
  definition: Definition<Record<string, unknown>, TReturn> & { inputSchema: JsonObject },
): BlockingWorkflowToolDefinition<Record<string, unknown>, WorkflowReturn<TReturn>>;
export function defineWorkflowTool<TInput = unknown, TOutput = unknown>(
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>>,
): WorkflowToolDefinition<TInput, TOutput>;
export function defineWorkflowTool<TInput, TOutput>(
  definition: Unbranded<WorkflowToolDefinition<TInput, TOutput>>,
): WorkflowToolDefinition<TInput, TOutput> {
  stampToolDefinition(definition, "defineWorkflowTool");
  return Object.assign(definition, { [WORKFLOW_TOOL_BRAND]: true as const });
}

export function isWorkflowToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, WORKFLOW_TOOL_BRAND) === true
  );
}
