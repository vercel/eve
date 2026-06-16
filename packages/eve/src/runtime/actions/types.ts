import { z } from "#compiled/zod/index.js";

import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";

/**
 * Runtime-owned authored tool-call request surfaced by a harness and executed
 * later by step-backed runtime code.
 */
export type RuntimeToolCallActionRequest = z.infer<typeof runtimeToolCallActionRequestSchema>;

/**
 * Zod schema for one runtime-owned authored tool-call action request.
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
 * Runtime-owned action request surfaced by a harness.
 *
 * Harness-native capabilities such as `bash` do not cross the harness boundary
 * as runtime actions. Only runtime-executed requests use this taxonomy.
 */
type RuntimeLoadSkillActionRequest = z.infer<typeof runtimeLoadSkillActionRequestSchema>;

/**
 * Zod schema for one runtime-owned load-skill action request.
 */
const runtimeLoadSkillActionRequestSchema = z
  .object({
    callId: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("load-skill"),
  })
  .strict();

/**
 * Runtime-owned action request surfaced by a harness.
 *
 * Harness-native capabilities such as `bash` do not cross the harness boundary
 * as runtime actions. Only runtime-executed requests use this taxonomy.
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
 * Runtime-owned subagent result projected back into a harness resume call.
 */
export type RuntimeSubagentResultActionResult = z.infer<
  typeof runtimeSubagentResultActionResultSchema
>;

/**
 * Zod schema for one runtime-owned subagent result action result.
 */
const runtimeSubagentResultActionResultSchema = z
  .object({
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("subagent-result"),
    output: jsonValueSchema,
    subagentName: z.string(),
  })
  .strict();

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
  | RuntimeSubagentResultActionResult
  | RuntimeToolResultActionResult;
