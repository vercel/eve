import { asSchema, jsonSchema, type ToolSet } from "ai";

import {
  DEFAULT_DYNAMIC_WORKFLOW_MAX_SUBAGENTS,
  serializeDynamicWorkflowInput,
  type DynamicWorkflowAgent,
  type DynamicWorkflowInput,
} from "#execution/dynamic-workflow/schema.js";
import { dynamicWorkflowBridgeRequestLimit } from "#execution/dynamic-workflow/program-step.js";
import type { HarnessToolMap } from "#harness/types.js";
import { parseJsonObject } from "#shared/json.js";
import {
  createWorkflowSandboxTool,
  type WorkflowSandboxContinuationSecurity,
} from "#shared/workflow-sandbox.js";

export const DYNAMIC_WORKFLOW_TOOL_NAME = "workflow";

/** Prepares the framework `workflow` tool from the subagents visible for this model step. */
export async function applyDynamicWorkflows(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly maxSubagents?: number;
  readonly tools: ToolSet;
}): Promise<{
  readonly harnessTools: HarnessToolMap;
  readonly modelTools: ToolSet;
}> {
  const definition = input.harnessTools.get(DYNAMIC_WORKFLOW_TOOL_NAME);
  const modelTool = input.tools[DYNAMIC_WORKFLOW_TOOL_NAME];
  if (definition === undefined || modelTool === undefined) {
    return { harnessTools: input.harnessTools, modelTools: input.tools };
  }
  if (definition.workflowId === undefined) {
    throw new Error('The framework "workflow" tool is not configured as a workflow tool.');
  }

  const agents = collectDynamicWorkflowAgents(input.harnessTools, input.tools);
  if (agents.length === 0) {
    const harnessTools = new Map(input.harnessTools);
    harnessTools.delete(DYNAMIC_WORKFLOW_TOOL_NAME);
    const modelTools = { ...input.tools };
    delete modelTools[DYNAMIC_WORKFLOW_TOOL_NAME];
    return { harnessTools, modelTools };
  }

  const maxSubagents = input.maxSubagents ?? DEFAULT_DYNAMIC_WORKFLOW_MAX_SUBAGENTS;
  const continuationSecurity = serializeContinuationSecurity(input.continuationSecurity);
  const description = await buildDynamicWorkflowDescription({
    agents,
    continuationSecurity,
    maxSubagents,
  });
  const harnessTools = new Map(input.harnessTools);
  harnessTools.set(DYNAMIC_WORKFLOW_TOOL_NAME, {
    ...definition,
    description,
    executeInput: (toolInput) =>
      serializeDynamicWorkflowInput({
        agents,
        continuationSecurity,
        js: readProgram(toolInput),
        maxSubagents,
      } satisfies DynamicWorkflowInput),
  });
  return {
    harnessTools,
    modelTools: {
      ...input.tools,
      [DYNAMIC_WORKFLOW_TOOL_NAME]: { ...modelTool, description },
    } as ToolSet,
  };
}

export const applyDynamicWorkflowTool = applyDynamicWorkflows;

function collectDynamicWorkflowAgents(
  harnessTools: HarnessToolMap,
  tools: ToolSet,
): DynamicWorkflowAgent[] {
  const agents: DynamicWorkflowAgent[] = [];
  for (const [name, definition] of harnessTools) {
    const tool = tools[name];
    if (name === DYNAMIC_WORKFLOW_TOOL_NAME || definition.resultKind !== "subagent" || !tool) {
      continue;
    }
    agents.push({
      description: definition.description
        .replace("This call starts a background task and returns a task receipt immediately.", "")
        .trim(),
      inputSchema: parseJsonObject(asSchema(tool.inputSchema).jsonSchema),
      name,
      outputSchema: null,
    });
  }
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

async function buildDynamicWorkflowDescription(input: {
  readonly agents: readonly DynamicWorkflowAgent[];
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly maxSubagents: number;
}): Promise<string> {
  const hostTools: Record<string, ToolSet[string]> = {};
  for (const agent of input.agents) {
    hostTools[agent.name] = {
      description: agent.description,
      inputSchema: jsonSchema(agent.inputSchema),
      execute: async () => null,
    } as ToolSet[string];
  }
  const generated = await createWorkflowSandboxTool({
    bridgeRequestLimit: dynamicWorkflowBridgeRequestLimit(input.maxSubagents),
    continuationSecurity: input.continuationSecurity,
    hostTools: hostTools as ToolSet,
  });
  const api = typeof generated.description === "string" ? generated.description : "";
  return [
    "Use `workflow` to run one JavaScript program that coordinates multiple child-agent calls and returns one JSON-serializable result.",
    "Only the listed agents are callable. Ordinary tools, search and describe helpers, approvals, authentication, connections, and session state are unavailable.",
    `A program may invoke at most ${String(input.maxSubagents)} agents. Use direct agent calls for simple fixed delegation; use workflow for loops, fan-out, dependent calls, filtering, or aggregation.`,
    api,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function serializeContinuationSecurity(
  security: WorkflowSandboxContinuationSecurity,
): DynamicWorkflowInput["continuationSecurity"] {
  if (typeof security.signingKey !== "string") {
    throw new Error("workflow requires string-backed continuation security.");
  }
  return {
    maxAgeMs: security.maxAgeMs,
    signingKey: security.signingKey,
  };
}

function readProgram(toolInput: unknown): string {
  const js = (toolInput as { readonly js?: unknown } | undefined)?.js;
  if (typeof js !== "string") throw new TypeError('workflow requires a "js" string program.');
  return js;
}
