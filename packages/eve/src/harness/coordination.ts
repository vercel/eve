import { observeToolOutput } from "#tool-stubs/execute.js";
import type { JSONValue, ModelMessage } from "ai";

import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolCallEntry,
} from "#shared/action-types.js";
import { SKILL_ENTRY_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { skillTarget } from "#shared/action-request-name.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { readHitlState } from "#harness/hitl/index.js";
import {
  findBlockingWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
} from "#harness/workflow-tool-runs.js";
import { normalizeToolModelOutput, toolModelOutputContext } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { commitCallEntry, commitTask, isTaskTool } from "#execution/tasks/model-step.js";
import type { PromotedTaskCall } from "#tools/task-handoff.js";
import { requireClearance, type Clearance } from "#harness/clearance.js";
import { admitWorkflowTask } from "#harness/workflow-admission.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import type { HarnessSession, HarnessToolLookup } from "#harness/types.js";
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

export function assertUniqueCoordinationCallIds(
  requests: readonly { readonly callId: string }[],
): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.callId)) {
      throw new Error(`Coordination batch contains duplicate callId "${request.callId}".`);
    }
    seen.add(request.callId);
  }
}

export function forgetFinishedRuns(
  session: HarnessSession,
  results: readonly RuntimeActionResult[],
  turnId: string,
): { readonly requestIds: readonly string[]; readonly session: HarnessSession } {
  let next = session;
  const requestIds: string[] = [];
  for (const result of results) {
    if (result.kind !== "tool-result") continue;
    const record = findBlockingWorkflowToolRun(next.state, result.callId, turnId);
    if (record === undefined) continue;
    for (const [requestId, route] of readHitlState(next.state).relays) {
      if (route.runId === record.address.runId) requestIds.push(requestId);
    }
    next = removeBlockingWorkflowToolRuns(next, turnId, record.callId);
  }
  return { requestIds, session: next };
}

export async function runtimeResultCalls(
  results: readonly RuntimeActionResult[],
  tools: HarnessToolLookup | undefined,
  programCalls: ReadonlySet<string> = new Set(),
): Promise<{ readonly part: ToolResultPart; readonly result: RuntimeActionResult }[]> {
  const settled: { part: ToolResultPart; result: RuntimeActionResult }[] = [];
  for (const result of results) {
    switch (result.kind) {
      case "load-skill-result":
        settled.push({
          part: toolResult(result, SKILL_TOOL_NAME, toToolResultOutput(result)),
          result,
        });
        continue;
      case "subagent-result":
        settled.push({
          part: toolResult(result, result.subagentName, toToolResultOutput(result)),
          result,
        });
        continue;
      case "tool-result":
        settled.push({
          part: toolResult(
            result,
            result.toolName,
            programCalls.has(result.callId)
              ? toToolResultOutput(result)
              : await projectToolResultOutput(result, tools?.get(result.toolName)),
          ),
          result,
        });
        continue;
    }
    throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
  }
  return settled;
}

function toolResult(
  result: RuntimeActionResult,
  toolName: string,
  output: ToolResultPart["output"],
): ToolResultPart {
  return { output, toolCallId: result.callId, toolName, type: "tool-result" };
}

export function collectWorkflowCalls(input: {
  readonly clearances: Readonly<Record<string, Clearance>>;
  readonly session: HarnessSession;
  readonly toolCalls: readonly CoordinationToolCall[];
  readonly tools: HarnessToolLookup;
  readonly turnId: string;
}): {
  readonly session: HarnessSession;
  readonly workflowRequests: readonly RuntimeWorkflowTaskRequest[];
} {
  let { session } = input;
  const workflowRequests: RuntimeWorkflowTaskRequest[] = [];
  for (const toolCall of input.toolCalls) {
    const definition = input.tools.get(toolCall.toolName);
    if (isTaskTool(definition)) continue;
    const clearance = input.clearances[toolCall.toolCallId];
    if (clearance === undefined)
      throw new Error(`Call "${toolCall.toolCallId}" has no clearance to dispatch.`);
    requireClearance(clearance, toolCall.toolCallId);
    const committed = commitCallEntry(session, {
      callId: toolCall.toolCallId,
      definition,
      input: resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      toolName: toolCall.toolName,
      turnId: input.turnId,
    });
    session = committed.session;
    workflowRequests.push(
      admitWorkflowTask(
        createCoordinationRequestFromToolCall({
          entry: committed.entry,
          input: committed.input,
          toolCall,
          tools: input.tools,
        }),
        clearance,
      ),
    );
  }
  return { session, workflowRequests };
}

export function collectPromotedTasks(input: {
  readonly promotedTasks: readonly PromotedTaskCall[];
  readonly session: HarnessSession;
  readonly turnId: string;
}): {
  readonly session: HarnessSession;
  readonly workflowRequests: readonly RuntimeWorkflowTaskRequest[];
} {
  let { session } = input;
  const workflowRequests: RuntimeWorkflowTaskRequest[] = [];
  for (const promoted of input.promotedTasks) {
    requireClearance(promoted.clearance, promoted.callId);
    const resolvedInput = resolveToolCallInputObject(promoted.input, {
      callId: promoted.callId,
      toolName: promoted.toolName,
    });
    const committed = commitTask(
      session,
      { callId: promoted.callId, toolName: promoted.toolName, turnId: input.turnId },
      "task",
      resolvedInput,
    );
    session = committed.session;
    workflowRequests.push(
      admitWorkflowTask(
        {
          callId: promoted.callId,
          entry: committed.entry,
          executeInput: promoted.handoff,
          input: committed.input,
          kind: "workflow-task",
          ...(promoted.preview !== undefined && { preview: promoted.preview }),
          toolName: promoted.toolName,
          workflowId: promoted.workflowId,
        },
        promoted.clearance,
      ),
    );
  }
  return { session, workflowRequests };
}

export interface CoordinationToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: CoordinationToolCall;
  readonly tools: HarnessToolLookup;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  const toolInput = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  const skill = input.toolCall.toolName === SKILL_ENTRY_NAME ? skillTarget(toolInput) : undefined;
  if (skill !== undefined) {
    return { callId: input.toolCall.toolCallId, input: toolInput, kind: "load-skill", name: skill };
  }
  const handling = definition?.behavior?.handling;
  if (
    definition !== undefined &&
    handling?.kind === "dispatch" &&
    handling.target.kind !== "workflow-tool-call"
  ) {
    const target = handling.target;
    const common = {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: toolInput,
      name: input.toolCall.toolName,
      nodeId: target.nodeId,
    };
    return target.kind === "remote-agent-call"
      ? { ...common, kind: "remote-agent-call", remoteAgentName: target.remoteAgentName }
      : { ...common, kind: "subagent-call", subagentName: target.subagentName };
  }
  const action: RuntimeActionRequest = {
    callId: input.toolCall.toolCallId,
    input: toolInput,
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
  return definition?.workflowId === undefined ? action : markRuntimeWorkflowToolAction(action);
}

export function createCoordinationRequestFromToolCall(input: {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly toolCall: CoordinationToolCall;
  readonly tools: HarnessToolLookup;
}): RuntimeWorkflowTaskRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  if (definition?.workflowId === undefined) {
    throw new Error(`Workflow tool "${input.toolCall.toolName}" has no workflow.`);
  }
  return {
    callId: input.toolCall.toolCallId,
    entry: input.entry,
    executeInput: definition.executeInput?.(input.input),
    input: input.input,
    kind: "workflow-task",
    toolName: input.toolCall.toolName,
    workflowId: definition.workflowId,
  };
}

export function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string" && value.trim() === "") {
    return {};
  }

  try {
    return parseJsonObject(typeof value === "string" ? JSON.parse(value) : value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}

async function projectToolResultOutput(
  result: Extract<RuntimeActionResult, { kind: "tool-result" }>,
  definition: HarnessToolDefinition | undefined,
): Promise<ToolResultPart["output"]> {
  if (
    result.isError === true ||
    definition?.toModelOutput === undefined ||
    startsTasks(definition)
  ) {
    return toToolResultOutput(result);
  }
  return await observeToolOutput(result.toolName, [{ callId: result.callId }], async () =>
    normalizeToolModelOutput({
      output: await definition.toModelOutput!(
        result.output,
        toolModelOutputContext(result.toolName, result.callId),
      ),
      toolCallId: result.callId,
      toolName: result.toolName,
    }),
  );
}

function toToolResultOutput(result: RuntimeActionResult): ToolResultPart["output"] {
  if (typeof result.output === "string")
    return { type: result.isError === true ? "error-text" : "text", value: result.output };
  return {
    type: result.isError === true ? "error-json" : "json",
    value: structuredClone(result.output) as JSONValue,
  };
}
