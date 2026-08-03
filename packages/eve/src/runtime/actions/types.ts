import { z } from "#compiled/zod/index.js";

import { agentTurnOutcomeSchema } from "#shared/agent-turn-outcome.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";
import { tokenUsageSchema } from "#shared/token-usage.js";

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

/**
 * Runtime-owned subagent-call request surfaced by a harness and executed later
 * by workflow-backed runtime code.
 */
export type RuntimeSubagentCallActionRequest = z.infer<
  typeof runtimeSubagentCallActionRequestSchema
>;

/**
 * Zod schema for one runtime-owned subagent-call action request.
 */
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

/**
 * Runtime-owned remote-agent-call request surfaced by a harness and executed
 * later by workflow-backed runtime code.
 */
export type RuntimeRemoteAgentCallActionRequest = z.infer<
  typeof runtimeRemoteAgentCallActionRequestSchema
>;

/**
 * Zod schema for one runtime-owned remote-agent-call action request.
 */
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
 * A `tool-call` is one action kind, alongside control-plane work such as
 * `load-skill` and runtime-dispatched subagent calls.
 */
export type RuntimeActionRequest =
  | RuntimeLoadSkillActionRequest
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest
  | RuntimeToolCallActionRequest;

/**
 * Zod schema for one runtime action request.
 */
export const runtimeActionRequestSchema = z.discriminatedUnion("kind", [
  runtimeLoadSkillActionRequestSchema,
  runtimeRemoteAgentCallActionRequestSchema,
  runtimeSubagentCallActionRequestSchema,
  runtimeToolCallActionRequestSchema,
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
 * `sessionId` names the callee session claiming the result; the parent
 * verifies it against the child identity captured at dispatch, so one callee
 * cannot settle a sibling's call. Older eve deployments do not send it, and
 * their results bind by callId alone. `usage` carries the turn's token spend
 * so the caller can attribute the subagent's tokens.
 *
 * `outcome` is the child engine's explicit lifecycle verdict for the settled
 * turn. The parent settles the agent handle from `outcome.kind` and folds
 * `outcome.usageDelta` into its session totals; `output`/`isError` remain
 * the tool-result projection shown to the model. Every producer states the
 * envelope explicitly — task-mode boundaries synthesize a terminal one —
 * so the parent never infers lifecycle from an absent field.
 *
 * `backgroundTask` marks the one parent-produced exception: delegated
 * dispatch resolves the model's tool call with a parked task receipt before
 * the child settles. Stream consumers use the marker to keep child lifecycle
 * open while still recording the receipt as the tool result.
 */
export type RuntimeSubagentChildResult = z.infer<typeof runtimeSubagentChildResultSchema>;

/**
 * Zod schema for one child-produced subagent result.
 */
const runtimeSubagentChildResultSchema = z
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
    outcome: agentTurnOutcomeSchema,
    output: jsonValueSchema,
    sessionId: z.string().optional(),
    subagentName: z.string(),
    usage: tokenUsageSchema.optional(),
  })
  .strict();

/**
 * Subagent failure synthesized on the parent side when no child produced a
 * result: dispatch rejections, start failures, and agentId-continuation
 * delivery errors. Always an error, and never claims a child `sessionId`.
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
    output: jsonValueSchema,
    sessionId: z.undefined().optional(),
    subagentName: z.string(),
  })
  .strict();

/**
 * Runtime-owned subagent result projected back into a harness resume call:
 * either a child-produced result or a parent-synthesized dispatch failure.
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
