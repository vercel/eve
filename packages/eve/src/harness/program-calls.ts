import { programAgentCallWorkflowReference } from "#execution/code-mode/agent-call-reference.js";
import type { ProgramAgentCallInput } from "#execution/code-mode/agent-call.js";
import { TASK_ID_INPUT } from "#execution/tasks/task-id-input.js";
import { entryPointOf, isAgentTool } from "#execution/tasks/tool-entry-point.js";
import { requireClearance, type Clearance } from "#harness/clearance.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolLookup } from "#harness/types.js";
import { admitWorkflowTask } from "#harness/workflow-admission.js";
import { agentModelsServeWorkflow } from "#runtime/subagents/workflow.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { readWorkflowFunctionId } from "#shared/workflow-function-id.js";

export type ProgramCallKind = "inline" | "workflow" | "agent" | "serve" | "program";

export function isProgramTool(definition: HarnessToolDefinition | undefined): boolean {
  return definition?.workflowProgram?.tools === true;
}

export function programCallKind(definition: HarnessToolDefinition): ProgramCallKind {
  if (definition.execute !== undefined) return "inline";
  if (isAgentTool(definition) || isAgentModelsTool(definition)) return "agent";
  if (isWorkflowProgramTool(definition)) return "program";
  return entryPointOf(definition) === "serve" ? "serve" : "workflow";
}

function isWorkflowProgramTool(definition: HarnessToolDefinition): boolean {
  return definition.workflowProgram !== undefined;
}

function isAgentModelsTool(definition: HarnessToolDefinition): boolean {
  const workflowId = readWorkflowFunctionId(agentModelsServeWorkflow);
  return workflowId !== undefined && definition.workflowId === workflowId;
}

export function splitProgramAgentInput(
  toolName: string,
  input: unknown,
): { readonly input: unknown; readonly outputSchema?: JsonObject } | { readonly issue: string } {
  if (!isObject(input)) return { input };
  const { outputSchema, ...rest } = input;
  if (rest[TASK_ID_INPUT] !== undefined) {
    return {
      issue: `"${toolName}" starts a new agent session on every call from a program, so it takes no ${TASK_ID_INPUT}. Put everything the agent needs in message.`,
    };
  }
  if (outputSchema === undefined) return { input: rest };
  if (!isObject(outputSchema)) {
    return { issue: `"${toolName}" takes outputSchema as a JSON Schema object.` };
  }
  return { input: rest, outputSchema: outputSchema as JsonObject };
}

export interface ProgramWorkflowCall {
  readonly callId: string;
  readonly clearance: Clearance;
  readonly input: JsonObject;
  readonly toolName: string;
}

export function collectProgramWorkflowCalls(
  calls: readonly ProgramWorkflowCall[],
  tools: HarnessToolLookup,
): readonly RuntimeWorkflowTaskRequest[] {
  return calls.map(({ callId, clearance, input, toolName }) => {
    requireClearance(clearance, callId);
    const definition = tools.get(toolName);
    if (definition?.workflowId === undefined) {
      throw new Error(`Workflow tool "${toolName}" has no workflow.`);
    }
    const request =
      programCallKind(definition) === "agent"
        ? {
            executeInput: agentCallInput(definition, toolName, input),
            workflowId: programAgentCallWorkflowReference.workflowId,
          }
        : { workflowId: definition.workflowId };
    return admitWorkflowTask(
      {
        ...request,
        callId,
        entry: { entryPoint: "execute" },
        input,
        kind: "workflow-task",
        toolName,
      },
      clearance,
    );
  });
}

function agentCallInput(
  definition: HarnessToolDefinition,
  toolName: string,
  input: JsonObject,
): JsonObject {
  const { message, model, outputSchema } = input;
  return {
    message: typeof message === "string" ? message : "",
    target: isAgentModelsTool(definition) ? "agent" : toolName,
    ...(typeof model === "string" && { model }),
    ...(isObject(outputSchema) && { outputSchema: outputSchema as JsonObject }),
  } satisfies ProgramAgentCallInput;
}

export function withoutModelOutput<T extends HarnessToolDefinition>(definition: T): T {
  if (definition.toModelOutput === undefined) return definition;
  const { toModelOutput: _projection, ...own } = definition;
  return own as T;
}

export function withOwnOutputs(tools: HarnessToolLookup): HarnessToolLookup {
  return {
    get: (name) => {
      const definition = tools.get(name);
      return definition === undefined ? undefined : withoutModelOutput(definition);
    },
  };
}
