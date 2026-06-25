import type { ToolSet } from "ai";

import type { SessionCapabilities } from "#channel/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { buildToolSet } from "#harness/tools.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import { workflowToolDescription } from "#harness/workflow-tool-description.js";
import {
  createWorkflowSandboxTool,
  readWorkflowSandboxResolution,
  requestWorkflowSandboxInterrupt,
  type WorkflowSandboxLifecycle,
  WORKFLOW_TOOL_NAME,
} from "#shared/workflow-sandbox.js";

interface WorkflowToolSet {
  readonly hostTools: ToolSet;
  readonly modelTools: ToolSet;
}

/**
 * Adds the dynamic `Workflow` tool while leaving every ordinary model tool
 * untouched. Only subagent and remote-agent runtime actions enter the sandbox.
 */
export async function applyWorkflowTool(input: {
  readonly harnessTools: HarnessToolMap;
  readonly lifecycle?: WorkflowSandboxLifecycle;
  readonly tools: ToolSet;
}): Promise<WorkflowToolSet> {
  const hostTools: Record<string, ToolSet[string]> = {};

  for (const name of Object.keys(input.tools)) {
    const harnessTool = input.harnessTools.get(name);
    if (harnessTool?.runtimeAction !== undefined) {
      hostTools[name] = createWorkflowRuntimeActionHostTool(harnessTool);
    }
  }

  if (Object.keys(hostTools).length === 0) {
    return { hostTools, modelTools: input.tools };
  }

  const workflowTool = await createWorkflowSandboxTool({
    hostTools,
    lifecycle: input.lifecycle,
  });
  const generated = typeof workflowTool.description === "string" ? workflowTool.description : "";
  const framing = workflowToolDescription(Object.keys(hostTools));
  const modelTools: Record<string, ToolSet[string]> = { ...input.tools };
  modelTools[WORKFLOW_TOOL_NAME] = {
    ...workflowTool,
    description: generated.length > 0 ? `${framing}\n\n${generated}` : framing,
  } as ToolSet[string];

  return {
    hostTools,
    modelTools: modelTools as ToolSet,
  };
}

/** Rebuilds the subagent-only host surface used to resume a parked workflow. */
export async function buildWorkflowHostTools(input: {
  readonly approvedTools?: ReadonlySet<string>;
  readonly capabilities?: SessionCapabilities;
  readonly tools: HarnessToolMap;
}): Promise<ToolSet> {
  const flatTools = buildToolSet({
    approvedTools: input.approvedTools,
    capabilities: input.capabilities,
    tools: input.tools,
  });
  return (await applyWorkflowTool({ harnessTools: input.tools, tools: flatTools })).hostTools;
}

function createWorkflowRuntimeActionHostTool(harnessTool: HarnessToolDefinition): ToolSet[string] {
  return {
    description: harnessTool.description,
    inputSchema: harnessTool.inputSchema,
    execute: async (toolInput: unknown, options: unknown) => {
      const resolution = readWorkflowSandboxResolution(options);
      if (resolution !== undefined) return resolution;

      return requestWorkflowSandboxInterrupt({
        kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
        runtimeAction: harnessTool.runtimeAction,
        toolInput,
        toolName: harnessTool.name,
      });
    },
  } as ToolSet[string];
}
