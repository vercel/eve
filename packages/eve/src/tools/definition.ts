import type { ToolExecutionOptions } from "ai";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";

import type { Approval } from "#approval/definition.js";
import type { SessionContext } from "#context/session-context.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenResult } from "#shared/connection-types.js";
import type { ToolAuthOptions, ToolAuthProvider } from "#tools/auth.js";
import {
  collectDurableDynamicToolCallbacks,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";
import { TOOL_BRAND } from "#tools/dynamic.js";
import type { ToolModelOutput } from "#tools/model-output.js";
import type { TaskDelegated, TaskExec, TaskReceipt } from "#tools/task.js";

type ApprovalContextInput<TInput> = unknown extends TInput ? Record<string, unknown> : TInput;

export type { ToolAuthDefinition, ToolAuthOptions, ToolAuthProvider } from "#tools/auth.js";
export type { ToolModelOutput, ToolModelOutputPart } from "#tools/model-output.js";
export type {
  TaskBinding,
  TaskDelegated,
  TaskExec,
  TaskExecutorBinding,
  TaskReceipt,
  TaskSendCommand,
} from "#tools/task.js";

export type ToolExecuteOptions = Omit<ToolExecutionOptions<unknown>, "context">;

export type ToolExecuteFn<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  options: ToolExecuteOptions,
  task?: TaskExec,
) => Promise<TOutput> | TOutput | AsyncIterable<TOutput>;

export type ToolExecution = "background";

interface ToolDefinitionBase {
  readonly description: string;
  readonly execution?: ToolExecution;
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
  | StandardSchemaV1<unknown, TInput>
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
 * Authored tool context. Passed as the last argument to
 * {@link ToolDefinition.execute}.
 *
 * Extends {@link SessionContext} with token accessors. Passing a provider
 * resolves that provider inline, which lets one tool use multiple credentials.
 */
export type ToolContext = SessionContext & {
  /** Aborts when the active turn is cancelled. */
  readonly abortSignal: AbortSignal;
  /**
   * Id of the current tool call — the same `callId` carried by the call's
   * stream events and its {@link ApprovalContext}.
   */
  readonly callId: string;
  /**
   * Final runtime name of the current tool, including any namespace
   * qualification. This is the same `toolName` carried by stream events and
   * the tool's {@link ApprovalContext}.
   */
  readonly toolName: string;
  /**
   * Resolves the bearer token for an inline provider. This accepts the same
   * auth shapes as a connection's `auth` field, including `connect("...")`
   * from `@vercel/connect/eve`.
   */
  getToken(provider: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult>;
  /**
   * Signals that the caller must complete authorization for an inline
   * provider before proceeding. Use this after a downstream `401` rejects a
   * token returned by {@link getToken}.
   */
  requireAuth(provider: ToolAuthProvider, options?: ToolAuthOptions): never;
};

/**
 * Public tool definition authored in `agent/tools/*.ts`.
 *
 * The tool's runtime name is the filename slug under `agent/tools/` without
 * the extension (`agent/tools/get_weather.ts` registers as `get_weather`).
 * Authored definitions have no `name` field; identity is path-derived.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> extends PublicToolDefinition<
  TInput,
  TOutput
> {
  readonly execution?: never;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput> | TOutput | AsyncIterable<TOutput>;
  /**
   * Optional per-tool approval gate. The return value determines whether
   * user approval is required before executing this tool.
   *
   * Use the helpers from `eve/tools/approval` for common cases:
   * - {@link always}: always require approval
   * - {@link never}: never require approval
   * - {@link once}: require approval only the first time per session
   */
  approval?: Approval<ApprovalContextInput<TInput>>;
  /**
   * Optional projection controlling what the model sees as the tool result.
   * Receives the full `TOutput` from {@link execute} and returns the
   * model-facing {@link ToolModelOutput}.
   *
   * When omitted, the model sees the full `execute` return value
   * (default AI SDK serialization). Channel event handlers
   * (`action.result`) always receive the full output regardless.
   */
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

/** A tool whose executor can outlive the model tool-call phase as a durable task. */
export interface BackgroundToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends PublicToolDefinition<TInput, TOutput> {
  readonly execution: "background";
  execute(
    input: TInput,
    ctx: ToolContext,
    task: TaskExec,
  ): Promise<TaskDelegated | TOutput> | TaskDelegated | TOutput;
  approval?: Approval<ApprovalContextInput<TInput>>;
  toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

type ToolOutputFromExecuteReturn<TReturn> =
  TReturn extends Promise<infer TOutput>
    ? TOutput
    : TReturn extends AsyncIterable<infer TOutput>
      ? TOutput
      : TReturn;

type BackgroundToolOutputFromExecuteReturn<TReturn> =
  ToolOutputFromExecuteReturn<TReturn> extends infer TOutput
    ? TOutput extends TaskDelegated<infer TData>
      ? TaskReceipt<TData>
      : TOutput
    : never;

type ToolDefinitionWithExecuteReturn<TInput, TOutput, TReturn> = ToolDefinition<TInput, TOutput> & {
  execute(input: TInput, ctx: ToolContext): TReturn;
};

type BackgroundToolDefinitionWithExecuteReturn<TInput, TOutput, TReturn> = BackgroundToolDefinition<
  TInput,
  TOutput
> & {
  execute(input: TInput, ctx: ToolContext, task: TaskExec): TReturn;
};

/**
 * Defines a tool configuration, used both for static tools (default export
 * from `agent/tools/*.ts`) and as the entry wrapper inside `defineDynamic`
 * resolvers.
 *
 * For static tools, the runtime tool name is the filename slug. `defineTool`
 * stamps a brand that lifecycle code validates; it rejects raw object literals.
 */
export function defineTool<
  TSchema extends StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>,
  TReturn,
>(definition: {
  description: BackgroundToolDefinition<unknown, unknown>["description"];
  execution: "background";
  inputSchema: TSchema;
  outputSchema?: PublicToolDefinition<
    unknown,
    BackgroundToolOutputFromExecuteReturn<TReturn>
  >["outputSchema"];
  execute(
    input: StandardSchemaV1.InferOutput<TSchema>,
    ctx: ToolContext,
    task: TaskExec,
  ): TReturn extends AsyncIterable<unknown> ? never : TReturn;
  approval?: BackgroundToolDefinition<StandardSchemaV1.InferOutput<TSchema>, unknown>["approval"];
  toModelOutput?: BackgroundToolDefinition<
    unknown,
    BackgroundToolOutputFromExecuteReturn<TReturn>
  >["toModelOutput"];
}): BackgroundToolDefinitionWithExecuteReturn<
  StandardSchemaV1.InferOutput<TSchema>,
  BackgroundToolOutputFromExecuteReturn<TReturn>,
  TReturn
>;
export function defineTool<
  TInputSchema extends StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | StandardJSONSchemaV1.InferOutput<TOutputSchema>
    | AsyncIterable<StandardJSONSchemaV1.InferOutput<TOutputSchema>>,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(input: StandardSchemaV1.InferOutput<TInputSchema>, ctx: ToolContext): TReturn;
  approval?: ToolDefinition<StandardSchemaV1.InferOutput<TInputSchema>, unknown>["approval"];
  toModelOutput?: ToolDefinition<
    unknown,
    StandardJSONSchemaV1.InferOutput<TOutputSchema>
  >["toModelOutput"];
}): ToolDefinitionWithExecuteReturn<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardJSONSchemaV1.InferOutput<TOutputSchema>,
  TReturn
>;
export function defineTool<
  TSchema extends StandardSchemaV1<unknown, unknown> | StandardJSONSchemaV1<unknown, unknown>,
  TReturn,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: TSchema;
  outputSchema?: JsonObject;
  execute(input: StandardSchemaV1.InferOutput<TSchema>, ctx: ToolContext): TReturn;
  approval?: ToolDefinition<StandardSchemaV1.InferOutput<TSchema>, unknown>["approval"];
  toModelOutput?: ToolDefinition<unknown, ToolOutputFromExecuteReturn<TReturn>>["toModelOutput"];
}): ToolDefinitionWithExecuteReturn<
  StandardSchemaV1.InferOutput<TSchema>,
  ToolOutputFromExecuteReturn<TReturn>,
  TReturn
>;
export function defineTool<
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TReturn extends
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | StandardJSONSchemaV1.InferOutput<TOutputSchema>
    | AsyncIterable<StandardJSONSchemaV1.InferOutput<TOutputSchema>>,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: JsonObject;
  outputSchema: TOutputSchema;
  execute(input: Record<string, unknown>, ctx: ToolContext): TReturn;
  approval?: ToolDefinition<Record<string, unknown>, unknown>["approval"];
  toModelOutput?: ToolDefinition<
    unknown,
    StandardJSONSchemaV1.InferOutput<TOutputSchema>
  >["toModelOutput"];
}): ToolDefinitionWithExecuteReturn<
  Record<string, unknown>,
  StandardJSONSchemaV1.InferOutput<TOutputSchema>,
  TReturn
>;
export function defineTool<TReturn>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  execute(input: Record<string, unknown>, ctx: ToolContext): TReturn;
  approval?: ToolDefinition<Record<string, unknown>, unknown>["approval"];
  toModelOutput?: ToolDefinition<unknown, ToolOutputFromExecuteReturn<TReturn>>["toModelOutput"];
}): ToolDefinitionWithExecuteReturn<
  Record<string, unknown>,
  ToolOutputFromExecuteReturn<TReturn>,
  TReturn
>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput> | BackgroundToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> | BackgroundToolDefinition<TInput, TOutput> {
  if ((definition as { readonly auth?: unknown }).auth !== undefined) {
    throw new Error(
      `defineTool: The "auth" field is no longer supported. ` +
        `Pass auth providers inline to ctx.getToken(provider) or ctx.requireAuth(provider).`,
    );
  }
  Object.assign(definition, { [TOOL_BRAND]: true });
  stampDurableDynamicToolCallbacks(
    definition,
    collectDurableDynamicToolCallbacks({
      approval: definition.approval as Approval<never> | undefined,
      execute: definition.execute,
      toModelOutput: definition.toModelOutput,
    }),
  );
  stampDefinitionKey(definition, `tool:${definition.description}`);
  return definition;
}

/**
 * Marker discriminator written into every {@link DisabledToolSentinel}.
 */
const DISABLED_TOOL_SENTINEL_KIND = "eve:disabled-tool";

/**
 * Marker value returned from {@link disableTool}. Export this as the default
 * export of a file in `agent/tools/` to remove the framework default whose
 * name matches the file's slug.
 */
export interface DisabledToolSentinel {
  readonly kind: typeof DISABLED_TOOL_SENTINEL_KIND;
}

/**
 * Returns a sentinel that disables the framework tool whose name matches the
 * containing file's slug.
 */
export function disableTool(): DisabledToolSentinel {
  return {
    kind: DISABLED_TOOL_SENTINEL_KIND,
  };
}

/**
 * Type guard: returns whether `value` is a {@link DisabledToolSentinel}
 * produced by {@link disableTool}.
 */
export function isDisabledToolSentinel(value: unknown): value is DisabledToolSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DISABLED_TOOL_SENTINEL_KIND
  );
}
