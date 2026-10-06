import { observeToolOutput } from "#tool-stubs/execute.js";
import type { ModelMessage } from "ai";

import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolCallEntry,
} from "#shared/action-types.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  findBlockingWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
} from "#harness/workflow-tool-runs.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { commitCallEntry, isTaskTool } from "#execution/tasks/model-step.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import type { HarnessSession, HarnessToolLookup } from "#harness/types.js";
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/** Rejects a batch before any result or side effect can bind ambiguously by call id. */
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

/**
 * Forgets the workflow runs whose results arrived. Nobody can answer what a finished run asked,
 * so its relayed requests are returned for the machine to withdraw.
 */
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
    for (const [requestId, route] of getProxyInputRequests(next.state)) {
      if (route.runId === record.address.runId) requestIds.push(requestId);
    }
    next = removeBlockingWorkflowToolRuns(next, turnId, record.callId);
  }
  return { requestIds, session: next };
}

/** Each runtime result as the model reads it, beside the result the stream reports. */
export async function runtimeResultCalls(
  results: readonly RuntimeActionResult[],
  tools: HarnessToolLookup | undefined,
): Promise<{ readonly part: ToolResultPart; readonly result: RuntimeActionResult }[]> {
  const settled: { part: ToolResultPart; result: RuntimeActionResult }[] = [];
  for (const result of results) {
    switch (result.kind) {
      case "load-skill-result":
        settled.push({
          part: toolResult(result, "load_skill", toToolResultOutput(result)),
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
            await projectToolResultOutput(result, tools?.get(result.toolName)),
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

/**
 * Turns a step's workflow tool calls into workflow runs, committing a task
 * record for each call that starts a task. Task tool calls stay in the
 * response alone: the session reads them from there.
 */
export function collectWorkflowCalls(input: {
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
      createCoordinationRequestFromToolCall({
        entry: committed.entry,
        input: committed.input,
        toolCall,
        tools: input.tools,
      }),
    );
  }
  return { session, workflowRequests };
}

/** The parts of a model tool call that coordination turns into a runtime request. */
export interface CoordinationToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: CoordinationToolCall;
  readonly tools: HarnessToolLookup;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  const toolInput = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  if (definition?.frameworkAction === "load-skill") {
    return {
      callId: input.toolCall.toolCallId,
      input: toolInput,
      kind: "load-skill",
    };
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

/**
 * Projects one workflow tool call into a workflow run request. The input is
 * the tool's own, without anything eve added to its model input.
 */
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

/**
 * Coerces an AI SDK tool-call `input` into the runtime-action `JsonObject`
 * contract, throwing a `TypeError` (with the original as `cause`) that names
 * the offending tool when the payload is not a JSON object.
 *
 * String inputs are parsed as JSON first: the model protocol carries tool
 * arguments as text, and provider-executed tool calls can surface that raw
 * string — or an empty string when the model sends no arguments.
 */
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
    return parseJsonObject(typeof value === "string" ? parseJsonStringInput(value) : value);
  } catch (error) {
    // This module is bundled into the workflow driver body, which cannot
    // import the logger, so enrich the error (and keep the original as
    // `cause`) for whatever catch site does the logging.
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}

function parseJsonStringInput(value: string): unknown {
  return JSON.parse(value);
}

/** Errors bypass `toModelOutput`, as they do for local execution. */
async function projectToolResultOutput(
  result: Extract<RuntimeActionResult, { kind: "tool-result" }>,
  definition: HarnessToolDefinition | undefined,
): Promise<ToolResultPart["output"]> {
  // A task tool's call result is its receipt; `toModelOutput` projects the task's result.
  if (
    result.isError === true ||
    definition?.toModelOutput === undefined ||
    startsTasks(definition)
  ) {
    return toToolResultOutput(result);
  }
  return await observeToolOutput(result.toolName, [{ callId: result.callId }], async () =>
    normalizeToolModelOutput({
      output: await definition.toModelOutput!(result.output),
      toolCallId: result.callId,
      toolName: result.toolName,
    }),
  );
}

function toToolResultOutput(result: RuntimeActionResult): ToolResultPart["output"] {
  if (typeof result.output === "string") {
    if (result.isError === true) {
      return {
        type: "error-text",
        value: result.output,
      };
    }

    return {
      type: "text",
      value: result.output,
    };
  }

  if (result.isError === true) {
    return {
      type: "error-json",
      value: toMutableJsonValue(result.output),
    };
  }

  return {
    type: "json",
    value: toMutableJsonValue(result.output),
  };
}

function toMutableJsonValue(value: RuntimeActionResult["output"]): MutableJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toMutableJsonValue(item));
  }

  const next: Record<string, MutableJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    next[key] = toMutableJsonValue(item);
  }

  return next;
}

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };
