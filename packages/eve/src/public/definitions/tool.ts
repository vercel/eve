import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { stampDefinitionKey } from "#public/tool-result-narrowing.js";
import type { PublicToolDefinition, ToolModelOutput } from "#shared/tool-definition.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { Approval } from "#public/definitions/approval.js";
import type { JsonObject } from "#shared/json.js";
import type {
  AuthorizationDefinition,
  ConnectionAuthorizationContext,
  NonInteractiveAuthorizationDefinition,
  TokenResult,
} from "#runtime/connections/types.js";
import {
  DYNAMIC_SENTINEL_KIND,
  TOOL_BRAND,
  type DynamicEvents,
  type DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";

type ApprovalContextInput<TInput> = unknown extends TInput ? Record<string, unknown> : TInput;

export type { ToolModelOutput } from "#shared/tool-definition.js";

/**
 * Authorization provider passed to {@link ToolContext.getToken} or
 * {@link ToolContext.requireAuth}. Accepts the same shapes as a connection's
 * `auth`:
 * - a `getToken`-only object (static API keys, pre-provisioned JWTs);
 *   `principalType` may be omitted and defaults to `"app"`.
 * - a full interactive OAuth definition (e.g. `connect("okta/myagent")` from
 *   `@vercel/connect/eve`, or {@link defineInteractiveAuthorization}).
 */
export type ToolAuthDefinition =
  | (Omit<NonInteractiveAuthorizationDefinition, "principalType"> & {
      readonly principalType?: NonInteractiveAuthorizationDefinition["principalType"];
    })
  | AuthorizationDefinition;

export type ToolAuthProvider = ToolAuthDefinition;

/**
 * Controls Eve runtime behavior for an inline tool auth provider.
 */
export interface ToolAuthOptions {
  /**
   * Connection metadata passed through to provider callbacks. Tool-only
   * providers usually leave this unset; connection-backed helpers can use it
   * to receive the upstream server URL.
   */
  readonly connection?: ConnectionAuthorizationContext;
  /**
   * Optional human-readable provider name shown in sign-in UI. Presentation
   * only; it does not affect OAuth scopes, token cache keys, or callback URLs.
   */
  readonly displayName?: string;
  /**
   * Optional Eve auth-flow key for token caches, callback URLs, pending
   * authorization state, and authorization completion. This is not an OAuth
   * scope. For Vercel Connect OAuth targeting such as `scopes`, `resources`,
   * or `authorizationDetails`, configure the provider with
   * `connect({ connector, tokenParams })`.
   */
  readonly authKey?: string;
}

/**
 * Authored tool context. Passed as the last argument to
 * {@link ToolDefinition.execute}.
 *
 * Extends {@link SessionContext} with token accessors. Passing a provider
 * resolves that provider inline, which lets one tool use multiple credentials.
 */
export type ToolContext = SessionContext & {
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
export type ToolDefinition<TInput = unknown, TOutput = unknown> = PublicToolDefinition<
  TInput,
  TOutput
> & {
  execute(input: TInput, ctx: ToolContext): Promise<TOutput> | TOutput;
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
  TInputSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(
    input: StandardJSONSchemaV1.InferOutput<TInputSchema>,
    ctx: ToolContext,
  ):
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | StandardJSONSchemaV1.InferOutput<TOutputSchema>;
  approval?: ToolDefinition<StandardJSONSchemaV1.InferOutput<TInputSchema>, unknown>["approval"];
  toModelOutput?: ToolDefinition<
    unknown,
    StandardJSONSchemaV1.InferOutput<TOutputSchema>
  >["toModelOutput"];
}): ToolDefinition<
  StandardJSONSchemaV1.InferOutput<TInputSchema>,
  StandardJSONSchemaV1.InferOutput<TOutputSchema>
>;
export function defineTool<
  TSchema extends StandardJSONSchemaV1<unknown, unknown>,
  TOutput,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: TSchema;
  outputSchema?: JsonObject;
  execute(
    input: StandardJSONSchemaV1.InferOutput<TSchema>,
    ctx: ToolContext,
  ): Promise<TOutput> | TOutput;
  approval?: ToolDefinition<StandardJSONSchemaV1.InferOutput<TSchema>, unknown>["approval"];
  toModelOutput?: ToolDefinition<unknown, TOutput>["toModelOutput"];
}): ToolDefinition<StandardJSONSchemaV1.InferOutput<TSchema>, TOutput>;
export function defineTool<
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>,
>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: JsonObject;
  outputSchema: TOutputSchema;
  execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ):
    | Promise<StandardJSONSchemaV1.InferOutput<TOutputSchema>>
    | StandardJSONSchemaV1.InferOutput<TOutputSchema>;
  approval?: ToolDefinition<Record<string, unknown>, unknown>["approval"];
  toModelOutput?: ToolDefinition<
    unknown,
    StandardJSONSchemaV1.InferOutput<TOutputSchema>
  >["toModelOutput"];
}): ToolDefinition<Record<string, unknown>, StandardJSONSchemaV1.InferOutput<TOutputSchema>>;
export function defineTool<TOutput>(definition: {
  description: ToolDefinition<unknown, unknown>["description"];
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<TOutput> | TOutput;
  approval?: ToolDefinition<Record<string, unknown>, unknown>["approval"];
  toModelOutput?: ToolDefinition<unknown, TOutput>["toModelOutput"];
}): ToolDefinition<Record<string, unknown>, TOutput>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput>;
export function defineTool<TInput = unknown, TOutput = unknown>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  if ((definition as { readonly auth?: unknown }).auth !== undefined) {
    throw new Error(
      `defineTool: The "auth" field is no longer supported. ` +
        `Pass auth providers inline to ctx.getToken(provider) or ctx.requireAuth(provider).`,
    );
  }
  Object.assign(definition, { [TOOL_BRAND]: true });
  stampDefinitionKey(definition, `tool:${definition.description}`);
  return definition;
}

/**
 * Defines a dynamic resolver evaluated at runtime from stream-event
 * handlers. It is shared across three slots, and the directory it is
 * authored in (not this function) decides what each handler must return
 * and which events are honored. The file's path-derived slug names the
 * single-entry case; a `Record<string, ...>` return names entries
 * `slug__key`. Return `null` to contribute nothing for that event.
 *
 * Per-slot return shape:
 * - `agent/tools/`: return a single `defineTool(...)`, a
 *   `Record<string, defineTool(...)>`, or `null`.
 * - `agent/skills/`: return a single `defineSkill(...)`, a
 *   `Record<string, defineSkill(...)>`, or `null`.
 * - `agent/instructions/`: return a single `defineInstructions({ markdown })`,
 *   which lowers to one `{ role: "system", content: markdown }` message,
 *   or `null`. (Maps are not meaningful here.)
 *
 * Per-slot events: tools resolvers run at `session.started`,
 * `turn.started`, and `step.started`. Instructions and skills resolvers
 * contribute to the system prompt, so for cache stability they run only
 * at `session.started` and `turn.started`; the runtime never invokes a
 * handler keyed on `step.started` in those slots.
 *
 * ```ts
 * import { defineDynamic, defineTool } from "eve/tools";
 * import { z } from "zod";
 *
 * export default defineDynamic({
 *   events: {
 *     "session.started": async (event, ctx) => ({
 *       export: defineTool({
 *         description: "Export data",
 *         inputSchema: z.object({ format: z.string() }),
 *         async execute(input) {
 *           return doExport(input.format);
 *         },
 *       }),
 *     }),
 *   },
 * });
 * ```
 *
 * A single return is named after the file slug. A map names each entry by its
 * bare key — there is no automatic slug prefix, so namespace keys yourself
 * (e.g. `team__playbook`) when a bare name might collide. A dynamic tool/skill
 * whose name matches an authored one overrides it; two dynamic resolvers
 * emitting the same name is an error.
 */
export function defineDynamic(definition: { readonly events: DynamicEvents }): DynamicSentinel {
  const sentinel: DynamicSentinel = {
    kind: DYNAMIC_SENTINEL_KIND,
    events: definition.events,
  };
  stampDefinitionKey(sentinel, `dynamic:${Object.keys(definition.events).join(",")}`);
  return sentinel;
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

/**
 * Marker discriminator written into the {@link ExperimentalWorkflow} opt-in
 * sentinel.
 */
const ENABLE_WORKFLOW_TOOL_SENTINEL_KIND = "eve:enable-workflow-tool";

/**
 * Marker value re-exported as the default export of a file in `agent/tools/`
 * (conventionally `agent/tools/workflow.ts`) to enable the framework `Workflow`
 * orchestration tool. The tool is off unless this marker is present,
 * mirroring the {@link disableTool} opt-out in reverse.
 */
export interface EnableWorkflowToolSentinel {
  readonly kind: typeof ENABLE_WORKFLOW_TOOL_SENTINEL_KIND;
}

/**
 * Opt-in marker for the framework `Workflow` tool, an isolated JavaScript sandbox whose
 * only callable operations are this agent's subagents and remote agents, for
 * orchestrating them from model-authored JavaScript. Re-export it as the
 * default export of `agent/tools/workflow.ts`:
 *
 * ```ts
 * export { ExperimentalWorkflow as default } from "eve/tools";
 * ```
 *
 * The capability is experimental. The resulting model-facing tool is still
 * called `Workflow`.
 */
export const ExperimentalWorkflow: EnableWorkflowToolSentinel = Object.freeze({
  kind: ENABLE_WORKFLOW_TOOL_SENTINEL_KIND,
});

/**
 * Type guard: returns whether `value` is the {@link ExperimentalWorkflow}
 * opt-in sentinel.
 */
export function isEnableWorkflowToolSentinel(value: unknown): value is EnableWorkflowToolSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === ENABLE_WORKFLOW_TOOL_SENTINEL_KIND
  );
}
