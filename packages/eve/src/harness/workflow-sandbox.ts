import type { ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { WORKFLOW_TASK_INTERRUPT_KIND } from "#harness/workflow-task-state.js";
import { DEFAULT_WORKFLOW_MAX_SUBAGENTS } from "#harness/workflow-subagent-limit.js";
import { workflowToolDescription } from "#harness/workflow-tool-description.js";
import {
  createWorkflowSandboxTool,
  readWorkflowSandboxResolution,
  requestWorkflowSandboxInterrupt,
  type WorkflowSandboxContinuationSecurity,
  WORKFLOW_TOOL_NAME,
} from "#shared/workflow-sandbox.js";

interface WorkflowToolSet {
  readonly hostTools: ToolSet;
  readonly modelTools: ToolSet;
}

const DEFAULT_WORKFLOW_SANDBOX_BRIDGE_REQUEST_LIMIT = 256;

const workflowInputSchema = z.strictObject({
  js: z
    .string()
    .describe(
      "Complete JavaScript orchestration program. Call only the agents listed in the Workflow description and return one JSON-serializable result.",
    ),
});

/**
 * Adds the dynamic `Workflow` tool while leaving every ordinary model tool
 * untouched. Only workflow-callable delegation tasks enter the sandbox.
 */
export async function applyWorkflowTool(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly maxSubagents?: number;
  readonly tools: ToolSet;
}): Promise<WorkflowToolSet> {
  const hostTools = createWorkflowHostTools(input.harnessTools, Object.keys(input.tools));

  if (Object.keys(hostTools).length === 0) {
    return { hostTools, modelTools: input.tools };
  }

  const workflowTool = await createWorkflowSandboxTool({
    bridgeRequestLimit: resolveWorkflowSandboxBridgeRequestLimit(input.maxSubagents),
    continuationSecurity: input.continuationSecurity,
    hostTools,
  });
  const generated = typeof workflowTool.description === "string" ? workflowTool.description : "";
  const framing = workflowToolDescription(Object.keys(hostTools), {
    maxSubagents: input.maxSubagents,
  });
  const apiReference = workflowApiReference(generated);
  const modelTools: Record<string, ToolSet[string]> = { ...input.tools };
  modelTools[WORKFLOW_TOOL_NAME] = {
    ...workflowTool,
    description: apiReference.length > 0 ? `${framing}\n\n${apiReference}` : framing,
    inputSchema: workflowInputSchema,
  } as ToolSet[string];

  return {
    hostTools,
    modelTools: modelTools as ToolSet,
  };
}

/**
 * Keeps code mode's bridge capacity strictly above eve's dispatch budget.
 * The extra request lets the first over-budget call resolve through eve's
 * `WORKFLOW_SUBAGENT_LIMIT_REACHED` result instead of failing the sandbox.
 */
export function resolveWorkflowSandboxBridgeRequestLimit(maxSubagents?: number): number {
  const dispatchBudget = maxSubagents ?? DEFAULT_WORKFLOW_MAX_SUBAGENTS;
  return Math.max(DEFAULT_WORKFLOW_SANDBOX_BRIDGE_REQUEST_LIMIT, dispatchBudget + 1);
}

function workflowApiReference(generatedDescription: string): string {
  const marker = "Tools:\n";
  const start = generatedDescription.indexOf(marker);
  if (start < 0) return generatedDescription;
  return `Available agent API:\n${generatedDescription.slice(start + marker.length)}`;
}

/** Rebuilds the subagent-only host surface used to resume a parked workflow. */
export function buildWorkflowHostTools(input: { readonly tools: HarnessToolMap }): ToolSet {
  return createWorkflowHostTools(input.tools, input.tools.keys());
}

function createWorkflowHostTools(tools: HarnessToolMap, names: Iterable<string>): ToolSet {
  const hostTools: Record<string, ToolSet[string]> = {};

  for (const name of names) {
    const tool = tools.get(name);
    if (tool?.task !== undefined) {
      hostTools[name] = createWorkflowTaskHostTool(tool);
    }
  }

  return hostTools as ToolSet;
}

function createWorkflowTaskHostTool(harnessTool: HarnessToolDefinition): ToolSet[string] {
  return {
    description: harnessTool.description,
    inputSchema: harnessTool.inputSchema,
    execute: async (toolInput: unknown, options: unknown) => {
      const resolution = readWorkflowSandboxResolution(options);
      if (resolution !== undefined) return resolution;

      return requestWorkflowSandboxInterrupt({
        kind: WORKFLOW_TASK_INTERRUPT_KIND,
        task: {
          executeInput: harnessTool.task?.executeInput?.(toolInput),
          nodeId: harnessTool.task?.nodeId,
          resultKind: harnessTool.task?.resultKind,
          workflowId: harnessTool.task?.workflowId,
        },
        toolInput,
        toolName: harnessTool.name,
      });
    },
  } as ToolSet[string];
}
