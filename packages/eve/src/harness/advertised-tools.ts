import type { ToolSet } from "ai";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { AGENT_TOOL_NAME } from "#runtime/framework-tools/agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import {
  ensureWorkflowContinuationSecurity,
  getWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { WorkflowSandboxLifecycle } from "#shared/workflow-sandbox.js";

type AdvertisedToolSession = Pick<HarnessSession, "rootSessionId" | "subagentDepth">;

type AdvertisedToolMapInput = {
  readonly session: AdvertisedToolSession;
  readonly tools: HarnessToolMap;
};

type AdvertisedToolDefinitionsInput = {
  readonly session: AdvertisedToolSession;
  readonly tools: readonly HarnessToolDefinition[];
};

type AdvertisedModelToolsInput = {
  readonly modelTools: ToolSet;
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
  readonly workflow?: {
    readonly lifecycle?: (input: {
      readonly session: HarnessSession;
      readonly tools: HarnessToolMap;
    }) => WorkflowSandboxLifecycle | undefined;
    readonly maxSubagents?: number;
  };
};

type AdvertisedModelTools = {
  readonly harnessTools: HarnessToolMap;
  readonly modelTools: ToolSet;
  readonly session: HarnessSession;
};

type AdvertisedToolsInput =
  | AdvertisedModelToolsInput
  | AdvertisedToolMapInput
  | AdvertisedToolDefinitionsInput;

export function getAdvertisedTools(input: AdvertisedModelToolsInput): Promise<AdvertisedModelTools>;

export function getAdvertisedTools(input: AdvertisedToolMapInput): HarnessToolMap;
export function getAdvertisedTools(
  input: AdvertisedToolDefinitionsInput,
): readonly HarnessToolDefinition[];
export function getAdvertisedTools(
  input: AdvertisedToolsInput,
): HarnessToolMap | Promise<AdvertisedModelTools> | readonly HarnessToolDefinition[] {
  if ("modelTools" in input) {
    return getAdvertisedModelTools(input);
  }

  if (isToolDefinitionList(input.tools)) {
    return filterUnavailableDelegationToolDefinitions(input.tools, input.session);
  }

  return filterUnavailableDelegationToolMap(input.tools, input.session);
}

async function getAdvertisedModelTools(
  input: AdvertisedModelToolsInput,
): Promise<AdvertisedModelTools> {
  const tools = filterUnavailableDelegationToolMap(input.tools, input.session);
  if (input.workflow === undefined) {
    return {
      harnessTools: tools,
      modelTools: input.modelTools,
      session: input.session,
    };
  }

  const workflowHostTools = filterWorkflowHostToolsForRootSession(tools, input.session);
  if (workflowHostTools.size === 0) {
    return {
      harnessTools: tools,
      modelTools: input.modelTools,
      session: input.session,
    };
  }

  const session = ensureWorkflowContinuationSecurity(input.session);
  const { modelTools } = await applyWorkflowTool({
    continuationSecurity: getWorkflowContinuationSecurity(session),
    harnessTools: workflowHostTools,
    lifecycle: input.workflow.lifecycle?.({ session, tools: workflowHostTools }),
    maxSubagents: input.workflow.maxSubagents,
    tools: input.modelTools,
  });

  return {
    harnessTools: tools,
    modelTools,
    session,
  };
}

function filterUnavailableDelegationToolDefinitions(
  tools: readonly HarnessToolDefinition[],
  session: AdvertisedToolSession,
): readonly HarnessToolDefinition[] {
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (shouldHideDelegationTool(tool, session)) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterUnavailableDelegationToolMap(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (shouldHideDelegationTool(tool, session)) {
      continue;
    }
    filteredTools.set(name, tool);
  }
  return filteredTools;
}

function filterWorkflowHostToolsForRootSession(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();
  const subagentDepth = resolveSubagentDepth(session);

  if (session.rootSessionId !== undefined || subagentDepth.currentDepth > 0) {
    return filteredTools;
  }

  for (const [name, tool] of tools) {
    if (isDelegatedRuntimeActionTool(tool)) {
      filteredTools.set(name, tool);
    }
  }
  return filteredTools;
}

function isDelegatedRuntimeActionTool(definition: HarnessToolDefinition): boolean {
  const runtimeAction = definition.runtimeAction;
  return runtimeAction?.kind === "subagent-call" || runtimeAction?.kind === "remote-agent-call";
}

function shouldHideDelegationTool(
  definition: HarnessToolDefinition,
  session: AdvertisedToolSession,
): boolean {
  if (
    definition.name !== AGENT_TOOL_NAME ||
    definition.runtimeAction?.kind !== "subagent-call" ||
    definition.runtimeAction.nodeId !== ROOT_RUNTIME_AGENT_NODE_ID
  ) {
    return false;
  }

  return session.rootSessionId !== undefined || resolveSubagentDepth(session).currentDepth > 0;
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
