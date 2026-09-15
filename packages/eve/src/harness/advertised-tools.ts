import type { ToolSet } from "ai";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  ensureWorkflowContinuationSecurity,
  getWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

type AdvertisedToolSession = Pick<HarnessSession, "rootSessionId" | "taskId">;

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
    return filterUnavailableToolDefinitions(input.tools, input.session);
  }

  return filterUnavailableToolMap(input.tools, input.session);
}

async function getAdvertisedModelTools(
  input: AdvertisedModelToolsInput,
): Promise<AdvertisedModelTools> {
  const tools = filterUnavailableToolMap(input.tools, input.session);
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
    maxSubagents: input.workflow.maxSubagents,
    tools: input.modelTools,
  });

  return {
    harnessTools: tools,
    modelTools,
    session,
  };
}

function filterUnavailableToolDefinitions(
  tools: readonly HarnessToolDefinition[],
  session: AdvertisedToolSession,
): readonly HarnessToolDefinition[] {
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (shouldHideTool(tool, session)) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterUnavailableToolMap(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (shouldHideTool(tool, session)) {
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

  if (session.rootSessionId !== undefined) {
    return filteredTools;
  }

  for (const [name, tool] of tools) {
    if (tool.resultKind === "subagent") {
      filteredTools.set(name, tool);
    }
  }
  return filteredTools;
}

function shouldHideTool(
  definition: HarnessToolDefinition,
  session: AdvertisedToolSession,
): boolean {
  const delegated = session.rootSessionId !== undefined;
  if (
    definition.rootOnly === true ||
    definition.behavior?.availability.includes("root-session") === true
  ) {
    return delegated;
  }
  if (definition.behavior?.availability.includes("delegated-task-child") === true) {
    return session.taskId === undefined;
  }

  return false;
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
