import { z } from "#compiled/zod/index.js";

import {
  agentTurnOutcomeSchema,
  agentTurnOutcomeWithCostSchema,
} from "#shared/agent-turn-outcome.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";
import { tokenUsageSchema, tokenUsageWithCostSchema } from "#shared/token-usage.js";

/**
 * Eve-owned `tool-call` action requested by the model.
 *
 * Depending on the tool definition, it can execute locally, be provider
 * executed, or be handled later by the runtime.
 */
export type RuntimeToolCallActionRequest = z.infer<typeof runtimeToolCallActionRequestSchema>;

/**
 * Zod schema for one Eve-owned `tool-call` action request.
 */
export const runtimeToolCallActionRequestSchema = z
  .object({
    callId: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("tool-call"),
    toolName: z.string(),
  })
  .strict();

export type RuntimeSubagentCallActionRequest = z.infer<
  typeof runtimeSubagentCallActionRequestSchema
>;

const runtimeSubagentCallActionRequestSchema = z
  .object({
    callId: z.string(),
    description: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("subagent-call"),
    name: z.string(),
    nodeId: z.string(),
    subagentName: z.string(),
  })
  .strict();

export type RuntimeRemoteAgentCallActionRequest = z.infer<
  typeof runtimeRemoteAgentCallActionRequestSchema
>;

export const runtimeRemoteAgentCallActionRequestSchema = z
  .object({
    callId: z.string(),
    description: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("remote-agent-call"),
    name: z.string(),
    nodeId: z.string(),
    remoteAgentName: z.string(),
  })
  .strict();

export type RuntimeWorkflowToolCallActionRequest = z.infer<
  typeof runtimeWorkflowToolCallActionRequestSchema
>;

const runtimeWorkflowToolCallActionRequestSchema = z
  .object({
    callId: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("workflow-tool-call"),
    toolName: z.string(),
    workflowId: z.string(),
  })
  .strict();

/**
 * Internal subagent dispatch request issued by the agent workflow task.
 *
 * This is deliberately not a {@link RuntimeActionRequest}: subagent tools are
 * workflow tasks, while runtime actions are reserved for framework controls.
 */
export type RuntimeSubagentDispatchRequest = z.infer<typeof runtimeSubagentDispatchRequestSchema>;

/**
 * Zod schema for one internal local-subagent dispatch request.
 */
const runtimeSubagentDispatchRequestSchema = z
  .object({
    callId: z.string(),
    description: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("subagent-call"),
    name: z.string(),
    nodeId: z.string(),
    subagentName: z.string(),
  })
  .strict();

/**
 * Internal remote-agent dispatch request issued by the agent workflow task.
 */
export type RuntimeRemoteAgentDispatchRequest = z.infer<
  typeof runtimeRemoteAgentDispatchRequestSchema
>;

/**
 * Zod schema for one internal remote-agent dispatch request.
 */
export const runtimeRemoteAgentDispatchRequestSchema = z
  .object({
    callId: z.string(),
    description: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("remote-agent-call"),
    name: z.string(),
    nodeId: z.string(),
    remoteAgentName: z.string(),
  })
  .strict();

/**
 * One workflow task requested by the harness. The turn owner starts the
 * durable run named by `workflowId`; blocking tools wait for its result,
 * while background tools settle after task admission.
 *
 * Tasks are the coordination contract for authored workflow tools and
 * subagents. They are intentionally separate from `RuntimeActionRequest`.
 */
export type RuntimeWorkflowTaskRequest = z.infer<typeof runtimeWorkflowTaskRequestSchema>;

export const runtimeWorkflowTaskRequestSchema = z
  .object({
    callId: z.string(),
    executeInput: jsonValueSchema.optional(),
    input: jsonObjectSchema,
    kind: z.literal("workflow-task"),
    nodeId: z.string().optional(),
    resultKind: z.enum(["subagent", "tool"]).optional(),
    toolName: z.string(),
    workflowId: z.string(),
  })
  .strict();

/**
 * Eve-owned `load-skill` action requested by the model.
 */
type RuntimeLoadSkillActionRequest = z.infer<typeof runtimeLoadSkillActionRequestSchema>;

/**
 * Zod schema for one Eve-owned `load-skill` action request.
 */
const runtimeLoadSkillActionRequestSchema = z
  .object({
    callId: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("load-skill"),
  })
  .strict();

/**
 * Eve-owned action request surfaced by the harness.
 *
 * `tool-call` covers ordinary model-visible calls, including framework task
 * controls. Deferred workflow and subagent execution uses
 * {@link RuntimeWorkflowTaskRequest} instead.
 */
export type RuntimeActionRequest =
  | RuntimeLoadSkillActionRequest
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest
  | RuntimeToolCallActionRequest
  | RuntimeWorkflowToolCallActionRequest;

/** Internal agent dispatch request owned by a workflow task. */
export type RuntimeAgentDispatchRequest =
  | RuntimeRemoteAgentDispatchRequest
  | RuntimeSubagentDispatchRequest;

/**
 * Zod schema for one runtime action request.
 */
export const runtimeActionRequestSchema = z.discriminatedUnion("kind", [
  runtimeLoadSkillActionRequestSchema,
  runtimeRemoteAgentCallActionRequestSchema,
  runtimeSubagentCallActionRequestSchema,
  runtimeToolCallActionRequestSchema,
  runtimeWorkflowToolCallActionRequestSchema,
]);

/**
 * Runtime-owned authored tool-result projected back into a harness resume call.
 */
export type RuntimeToolResultActionResult = z.infer<typeof runtimeToolResultActionResultSchema>;

/**
 * Zod schema for one runtime-owned authored tool-result action result.
 */
const runtimeToolResultActionResultSchema = z
  .object({
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("tool-result"),
    output: jsonValueSchema,
    toolName: z.string(),
  })
  .strict();

/**
 * Subagent result produced by a dispatched child session and delivered back
 * through the parent's resume hook.
 *
 * Results bind to the pending call by callId alone: possession of the
 * parent's callback token is the authorization to settle, so no further
 * identity verification happens here. Under the accepted at-least-once
 * dispatch window a replay-orphaned duplicate child holds the same token
 * and callId and may settle the call in place of the owned child — its
 * output is computed from the same input, and this is an accepted
 * trade-off, not an oversight.
 *
 * `outcome` is the child engine's explicit lifecycle verdict for the settled
 * turn. The parent settles the agent handle from `outcome.kind` and folds
 * `outcome.usageDelta` into its session totals; `output`/`isError` remain
 * the tool-result projection shown to the model. Every producer states the
 * envelope explicitly — task-mode boundaries synthesize a terminal one —
 * so the parent never infers lifecycle from an absent field. `usage`
 * carries the turn's token spend so the caller can attribute the
 * subagent's tokens.
 *
 * `backgroundTask` marks the one parent-produced exception: delegated
 * dispatch resolves the model's tool call with a parked task receipt before
 * the child settles. Stream consumers use the marker to keep child lifecycle
 * open while still recording the receipt as the tool result.
 */
export interface RuntimeSubagentChildResult {
  readonly backgroundTask?: {
    readonly status: "working";
    readonly taskId: string;
  };
  readonly callId: string;
  readonly isError?: boolean;
  readonly kind: "subagent-result";
  readonly origin: "child";
  readonly outcome: import("#shared/agent-turn-outcome.js").AgentTurnOutcome;
  readonly output: import("#shared/json.js").JsonValue;
  readonly subagentName: string;
  readonly usage?: import("#shared/token-usage.js").TokenUsage;
}

const runtimeSubagentChildResultFields = {
  backgroundTask: z
    .strictObject({
      status: z.literal("working"),
      taskId: z.string(),
    })
    .optional(),
  callId: z.string(),
  isError: z.boolean().optional(),
  kind: z.literal("subagent-result"),
  origin: z.literal("child"),
  output: jsonValueSchema,
  subagentName: z.string(),
};

/** Token-only subagent result schema retained for historical wire formats. */
export const runtimeSubagentChildResultSchema = z
  .object({
    backgroundTask: z
      .strictObject({
        status: z.literal("working"),
        taskId: z.string(),
      })
      .optional(),
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("subagent-result"),
    origin: z.literal("child"),
    outcome: agentTurnOutcomeSchema,
    output: jsonValueSchema,
    subagentName: z.string(),
    usage: tokenUsageSchema.optional(),
  })
  .strict();

/** Current subagent result schema, including optional model token cost. */
export const runtimeSubagentChildResultWithCostSchema: z.ZodType<RuntimeSubagentChildResult> = z
  .object({
    ...runtimeSubagentChildResultFields,
    outcome: agentTurnOutcomeWithCostSchema,
    usage: tokenUsageWithCostSchema.optional(),
  })
  .strict();

/**
 * Subagent failure synthesized on the parent side when no child produced a
 * result: dispatch rejections, start failures, and agentId-continuation
 * delivery errors. Always an error. Enters the harness only through the
 * trusted step-result path, never through the shared callback inbox.
 */
export type RuntimeSubagentDispatchFailure = z.infer<typeof runtimeSubagentDispatchFailureSchema>;

/**
 * Zod schema for one parent-synthesized subagent dispatch failure.
 */
const runtimeSubagentDispatchFailureSchema = z
  .object({
    callId: z.string(),
    isError: z.literal(true),
    kind: z.literal("subagent-result"),
    origin: z.literal("dispatch"),
    output: jsonValueSchema,
    subagentName: z.string(),
  })
  .strict();

/**
 * Runtime-owned subagent result projected back into a harness resume call,
 * discriminated on `origin`: `child` results come from a dispatched child
 * session and must bind to a running agent handle; `dispatch` failures are
 * parent-synthesized and trusted by construction.
 */
export type RuntimeSubagentResult = RuntimeSubagentChildResult | RuntimeSubagentDispatchFailure;

/**
 * Runtime-owned action result produced by framework-owned loading code.
 */
type RuntimeLoadSkillActionResult = z.infer<typeof runtimeLoadSkillActionResultSchema>;

/**
 * Zod schema for one runtime-owned load-skill action result.
 *
 * The result still reports whether a skill became active during the turn; the
 * action name reflects how the model requests those instructions.
 */
const runtimeLoadSkillActionResultSchema = z
  .object({
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("load-skill-result"),
    output: jsonValueSchema,
    name: z.string().optional(),
  })
  .strict();

/**
 * Runtime-owned action result produced by framework-owned runtime code.
 */
export type RuntimeActionResult =
  | RuntimeLoadSkillActionResult
  | RuntimeSubagentResult
  | RuntimeToolResultActionResult;
