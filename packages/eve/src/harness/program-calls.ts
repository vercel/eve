// How a program's calls differ from the model's own: a program awaits what it calls. An agent
// resolves to its reply and a `task` tool to its result, never to a task receipt, so each such
// call runs as an `execute` run the `eve__execute` call waits on. Everything else about a call,
// its entry, input validation, approval, sign-in, and events, is the model's path.

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

/** How a program's call to an entry runs. */
export type ProgramCallKind =
  /** In the program's step, like a model step's local call. */
  | "inline"
  /** As a run the program waits on: an `execute` or `task` workflow tool. */
  | "workflow"
  /** As a run that sends one message to a new session of the agent and returns its reply. */
  | "agent"
  /** Not from a program: its task stays open between calls, which only the model can hold. */
  | "serve";

export function programCallKind(definition: HarnessToolDefinition): ProgramCallKind {
  if (definition.execute !== undefined) return "inline";
  if (isAgentTool(definition) || isAgentModelsTool(definition)) return "agent";
  return entryPointOf(definition) === "serve" ? "serve" : "workflow";
}

/** `agent({ models })`: a copy of the root on the model its call names. */
function isAgentModelsTool(definition: HarnessToolDefinition): boolean {
  const workflowId = readWorkflowFunctionId(agentModelsServeWorkflow);
  return workflowId !== undefined && definition.workflowId === workflowId;
}

/**
 * A program's input to an agent, split into what the agent's tool validates and the caller's
 * `outputSchema`. A program can't continue a task: each call starts a new session.
 */
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

/** A call of a program the runtime runs, with the gate's decision that it may. */
export interface ProgramWorkflowCall {
  readonly callId: string;
  readonly clearance: Clearance;
  /** The program's input to the entry. */
  readonly input: JsonObject;
  readonly toolName: string;
}

/**
 * Turns a program's workflow and agent calls into the runs the `eve__execute` call waits on.
 * None starts a task, so none commits a task record: the model's task table never holds them.
 */
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
    // `agent({ models })` opens a copy of the root; every other agent tool is named for its agent.
    target: isAgentModelsTool(definition) ? "agent" : toolName,
    ...(typeof model === "string" && { model }),
    ...(isObject(outputSchema) && { outputSchema: outputSchema as JsonObject }),
  } satisfies ProgramAgentCallInput;
}

/** `tools` with each entry's own output: a program reads what a tool returned, never its projection for the model. */
export function withOwnOutputs(tools: HarnessToolLookup): HarnessToolLookup {
  return {
    get: (name) => {
      const definition = tools.get(name);
      if (definition?.toModelOutput === undefined) return definition;
      const { toModelOutput: _projection, ...own } = definition;
      return own;
    },
  };
}
