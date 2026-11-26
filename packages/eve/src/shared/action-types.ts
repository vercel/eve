import { z } from "#compiled/zod/index.js";

import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";
import { clearedBySchema } from "#protocol/session-events/families/call.js";

export type RuntimeToolCallActionRequest = z.infer<typeof runtimeToolCallActionRequestSchema>;

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

const runtimeRemoteAgentCallActionRequestSchema = z
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

export type RuntimeSubagentDispatchRequest = z.infer<typeof runtimeSubagentDispatchRequestSchema>;

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

export type RuntimeRemoteAgentDispatchRequest = z.infer<
  typeof runtimeRemoteAgentDispatchRequestSchema
>;

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

export type WorkflowToolRunEntry = Exclude<
  WorkflowToolCallEntry,
  { readonly entryPoint: "receive" }
>;

export type WorkflowToolCallEntry = z.infer<typeof workflowToolCallEntrySchema>;

const workflowToolCallEntrySchema = z.discriminatedUnion("entryPoint", [
  z.object({ entryPoint: z.literal("execute") }).strict(),
  z.object({ entryPoint: z.literal("task"), taskId: z.string() }).strict(),
  z.object({ entryPoint: z.literal("serve"), taskId: z.string() }).strict(),
  z.object({ entryPoint: z.literal("receive"), taskId: z.string() }).strict(),
]);

export type RuntimeWorkflowTaskRequest = z.infer<typeof runtimeWorkflowTaskRequestSchema>;

export const runtimeWorkflowTaskRequestSchema = z
  .object({
    callId: z.string(),
    admission: z.object({ callId: z.string(), fingerprint: z.string() }).strict().optional(),
    clearedBy: clearedBySchema.optional(),
    entry: workflowToolCallEntrySchema,
    executeInput: jsonValueSchema.optional(),
    input: jsonObjectSchema,
    kind: z.literal("workflow-task"),
    preview: z.string().optional(),
    toolName: z.string(),
    workflowId: z.string(),
  })
  .strict();

type RuntimeLoadSkillActionRequest = z.infer<typeof runtimeLoadSkillActionRequestSchema>;

const runtimeLoadSkillActionRequestSchema = z
  .object({
    callId: z.string(),
    input: jsonObjectSchema,
    kind: z.literal("load-skill"),
    name: z.string(),
  })
  .strict();

export type RuntimeActionRequest =
  | RuntimeLoadSkillActionRequest
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest
  | RuntimeToolCallActionRequest
  | RuntimeWorkflowToolCallActionRequest;

const RUNTIME_WORKFLOW_TOOL_ACTION = Symbol.for("eve:runtime-workflow-tool-action");

export function markRuntimeWorkflowToolAction(
  action: RuntimeToolCallActionRequest,
): RuntimeToolCallActionRequest {
  Object.defineProperty(action, RUNTIME_WORKFLOW_TOOL_ACTION, { value: true });
  return action;
}

export function isRuntimeWorkflowToolAction(action: RuntimeActionRequest): boolean {
  return (
    action.kind === "workflow-tool-call" ||
    (action.kind === "tool-call" && Reflect.get(action, RUNTIME_WORKFLOW_TOOL_ACTION) === true)
  );
}

export type RuntimeAgentDispatchRequest =
  | RuntimeRemoteAgentDispatchRequest
  | RuntimeSubagentDispatchRequest;

export type RuntimeToolResultActionResult = z.infer<typeof runtimeToolResultActionResultSchema>;

const runtimeToolResultActionResultSchema = z
  .object({
    callId: z.string(),
    errorName: z.string().optional(),
    isError: z.boolean().optional(),
    kind: z.literal("tool-result"),
    output: jsonValueSchema,
    toolName: z.string(),
  })
  .strict();

export interface RuntimeSubagentChildResult {
  readonly callId: string;
  readonly isError?: boolean;
  readonly kind: "subagent-result";
  readonly origin: "child";
  readonly outcome: import("#shared/agent-turn-outcome.js").AgentTurnOutcome;
  readonly output: import("#shared/json.js").JsonValue;
  readonly subagentName: string;
  readonly usage?: import("#shared/token-usage.js").TokenUsage;
}

export type RuntimeSubagentDispatchFailure = z.infer<typeof runtimeSubagentDispatchFailureSchema>;

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

export type RuntimeSubagentResult = RuntimeSubagentChildResult | RuntimeSubagentDispatchFailure;

type RuntimeLoadSkillActionResult = z.infer<typeof runtimeLoadSkillActionResultSchema>;

const runtimeLoadSkillActionResultSchema = z
  .object({
    callId: z.string(),
    isError: z.boolean().optional(),
    kind: z.literal("load-skill-result"),
    name: z.string(),
    output: jsonValueSchema,
  })
  .strict();

export type RuntimeActionResult =
  | RuntimeLoadSkillActionResult
  | RuntimeSubagentResult
  | RuntimeToolResultActionResult;
