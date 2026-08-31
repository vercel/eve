import type { ToolSet } from "ai";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import {
  ensureWorkflowContinuationSecurity,
  getWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

type AdvertisedToolSession = Pick<HarnessSession, "rootSessionId" | "subagentDepth">;

type AdvertisedToolMapInput = {
  readonly canRequestInput?: boolean;
  readonly delegatedCaller?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: HarnessToolMap;
};

type AdvertisedToolDefinitionsInput = {
  readonly canRequestInput?: boolean;
  readonly delegatedCaller?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: readonly HarnessToolDefinition[];
};

type AdvertisedModelToolsInput = {
  readonly canRequestInput?: boolean;
  readonly delegatedCaller?: boolean;
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
    return filterUnavailableDelegationToolDefinitions(input.tools, input.session, input);
  }

  return filterUnavailableToolMap(input.tools, input.session, input);
}

async function getAdvertisedModelTools(
  input: AdvertisedModelToolsInput,
): Promise<AdvertisedModelTools> {
  const tools = filterUnavailableToolMap(input.tools, input.session, input);
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

function filterUnavailableDelegationToolDefinitions(
  tools: readonly HarnessToolDefinition[],
  session: AdvertisedToolSession,
  availability: Pick<AdvertisedToolDefinitionsInput, "canRequestInput" | "delegatedCaller">,
): readonly HarnessToolDefinition[] {
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (!isToolAvailable(tool, session, availability)) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterUnavailableToolMap(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
  availability: Pick<AdvertisedToolMapInput, "canRequestInput" | "delegatedCaller">,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (!isToolAvailable(tool, session, availability)) {
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
    const target =
      tool.behavior?.handling?.kind === "dispatch" ? tool.behavior.handling.target : undefined;
    if (
      target?.kind === "self-agent-call" ||
      target?.kind === "subagent-call" ||
      target?.kind === "remote-agent-call"
    ) {
      filteredTools.set(name, tool);
    }
  }
  return filteredTools;
}

function isToolAvailable(
  definition: HarnessToolDefinition,
  session: AdvertisedToolSession,
  availability: {
    readonly canRequestInput?: boolean;
    readonly delegatedCaller?: boolean;
  },
): boolean {
  for (const condition of definition.behavior?.availability ?? []) {
    switch (condition) {
      case "delegated-task-child":
        if (availability.delegatedCaller !== true) return false;
        break;
      case "requires-request-input":
        if (availability.canRequestInput !== true) return false;
        break;
      case "root-session":
        if (session.rootSessionId !== undefined || resolveSubagentDepth(session).currentDepth > 0) {
          return false;
        }
        break;
      default: {
        const _exhaustive: never = condition;
        return _exhaustive;
      }
    }
  }
  return true;
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
