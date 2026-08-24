import {
  createBackgroundSubagentHarnessDefinition,
  createHarnessDelegationToolDefinition,
} from "#execution/delegation-tool.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#kernel/agent.js";
import { createAskQuestionHarnessDefinition } from "#kernel/ask-question.js";
import type { KernelCapabilityName, KernelCapabilityPlan } from "#kernel/capabilities.js";
import { materializePreparedKernelNodeTools } from "#kernel/executable-capabilities.js";
import { createTaskCancelHarnessDefinition } from "#kernel/task-cancel.js";
import { createTaskUpdateHarnessDefinition } from "#kernel/task-update.js";
import { createWebSearchHarnessDefinition } from "#kernel/web-search.js";
import {
  PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#runtime/subagents/registry.js";

export interface MaterializeKernelNodeInput {
  readonly nodeId: string;
  readonly persistentSubagentSessions: boolean;
  readonly plan: KernelCapabilityPlan;
  readonly tasksEnabled: boolean;
}

/** Materializes every node-scoped native definition selected by the plan. */
export function materializeKernelNodeTools(input: MaterializeKernelNodeInput): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();
  const definitions = materializePreparedKernelNodeTools(input.plan, {
    agent: (name) => materializeAgentTool(name, input),
    askQuestion: (name) => withKernelCapability(createAskQuestionHarnessDefinition(), name),
    taskCancel: (name) => withKernelCapability(createTaskCancelHarnessDefinition(), name),
    taskUpdate: (name) => withKernelCapability(createTaskUpdateHarnessDefinition(), name),
    webSearch: (name) => withKernelCapability(createWebSearchHarnessDefinition(), name),
  });
  for (const definition of definitions) tools.set(definition.name, definition);

  return tools;
}

function materializeAgentTool(
  name: typeof AGENT_TOOL_NAME,
  input: MaterializeKernelNodeInput,
): HarnessToolDefinition {
  const implicitAgent = {
    description: AGENT_TOOL_DESCRIPTION,
    inputSchema:
      input.tasksEnabled || input.persistentSubagentSessions
        ? PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA
        : SUBAGENT_TOOL_INPUT_SCHEMA,
    kind: "subagent" as const,
    name: AGENT_TOOL_NAME,
    nodeId: input.nodeId,
  };
  return withKernelCapability(
    input.tasksEnabled
      ? createBackgroundSubagentHarnessDefinition(implicitAgent)
      : createHarnessDelegationToolDefinition(implicitAgent),
    name,
  );
}

export function withKernelCapability(
  definition: HarnessToolDefinition,
  kernelCapability: KernelCapabilityName,
): HarnessToolDefinition {
  return { ...definition, kernelCapability };
}
