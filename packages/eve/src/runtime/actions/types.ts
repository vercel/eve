import { z } from "#compiled/zod/index.js";

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
 * Results bind to the pending call by callId alone: possession of the
 * parent's callback token is the authorization to settle, so no further
 * identity verification happens here. Under the accepted at-least-once
 * dispatch window a replay-orphaned duplicate child holds the same token
 * and callId and may settle the call in place of the owned child — its
 * output is computed from the same input, and this is an accepted
 * trade-off, not an oversight. `usage` carries the completed child
 * session's token totals so the caller can attribute the subagent's spend.
 */
export type RuntimeSubagentChildResult = z.infer<typeof runtimeSubagentChildResultSchema>;

/**
 * Zod schema for one child-produced subagent result.
 */
const runtimeSubagentChildResultSchema = z
  .object({
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("subagent-result"),
    origin: z.literal("child"),
    output: jsonValueSchema,
    subagentName: z.string(),
    usage: tokenUsageSchema.optional(),
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
