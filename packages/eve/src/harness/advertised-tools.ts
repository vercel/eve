import type { ToolSet } from "ai";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { TASK_TOOL_NAMES, TASK_UPDATE_TOOL_NAME } from "#tools/framework/task-contract.js";
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
  readonly delegatedCaller?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: HarnessToolMap;
};

type AdvertisedToolDefinitionsInput = {
  readonly delegatedCaller?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: readonly HarnessToolDefinition[];
};

type AdvertisedModelToolsInput = {
  readonly delegatedCaller?: boolean;
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
    return filterUnavailableDelegationToolDefinitions(
      input.tools,
      input.session,
      input.delegatedCaller,
    );
  }

  return filterUnavailableDelegationToolMap(input.tools, input.session, input.delegatedCaller);
}

async function getAdvertisedModelTools(
  input: AdvertisedModelToolsInput,
): Promise<AdvertisedModelTools> {
  const tools = filterUnavailableDelegationToolMap(
    input.tools,
    input.session,
    input.delegatedCaller,
  );
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
  delegatedCaller: boolean | undefined,
): readonly HarnessToolDefinition[] {
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (shouldHideDelegationTool(tool, session, delegatedCaller)) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterUnavailableDelegationToolMap(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
  delegatedCaller: boolean | undefined,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (shouldHideDelegationTool(tool, session, delegatedCaller)) {
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
    if (tool.workflowCallable === true) {
      filteredTools.set(name, tool);
    }
  }
  return filteredTools;
}

function shouldHideDelegationTool(
  definition: HarnessToolDefinition,
  session: AdvertisedToolSession,
  delegatedCaller: boolean | undefined,
): boolean {
  if (definition.name === TASK_UPDATE_TOOL_NAME) return delegatedCaller !== true;
  if (isRootOnlyTransitionalTool(definition)) {
    return session.rootSessionId !== undefined || resolveSubagentDepth(session).currentDepth > 0;
  }

  return false;
}

/**
 * Tools that only a root session may see. The `agent` self-delegation
 * tool and parent-side `experimental.tasks` controls are injected from the root
 * node's config, which self-delegated children share — session shape is
 * the only signal that separates the root from its children.
 */
function isRootOnlyTransitionalTool(definition: HarnessToolDefinition): boolean {
  if (definition.rootOnly === true) return true;
  if (
    definition.name === AGENT_TOOL_NAME &&
    definition.runtimeAction?.kind === "subagent-call" &&
    definition.runtimeAction.nodeId === ROOT_RUNTIME_AGENT_NODE_ID
  ) {
    return true;
  }

  return definition.name !== TASK_UPDATE_TOOL_NAME && TASK_TOOL_NAMES.has(definition.name);
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
