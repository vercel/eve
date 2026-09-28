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
   * response resolves, or starts the next turn when the session is idle.
   */
  send<TOutput = unknown>(
    message: string,
    options?: AgentSendOptions<TOutput>,
  ): Promise<AgentResponse<TOutput>>;
}

/**
 * Context supplied to a workflow tool body. When passed directly to a step,
 * eve replaces it with {@link WorkflowStepToolContext}.
 */
export type WorkflowToolContext = Pick<
  ToolContext,
  "abortSignal" | "callId" | "session" | "toolName" | "getToken" | "requireAuth"
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
  /**
   * Aborts once, on the first steering message that arrives while the turn
   * waits on this call. What it means is the tool's choice: a body that
   * ignores it keeps going, and one that should stop early races or passes it.
   */
  readonly interruptSignal: AbortSignal;
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
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

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
