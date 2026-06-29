import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveSubagentDelegationLimit } from "#harness/subagent-depth.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

type AdvertisedToolMapInput = {
  readonly session: Pick<HarnessSession, "subagentDepth" | "subagentMaxDepth">;
  readonly tools: HarnessToolMap;
};

type AdvertisedToolDefinitionsInput = {
  readonly session: Pick<HarnessSession, "subagentDepth" | "subagentMaxDepth">;
  readonly tools: readonly HarnessToolDefinition[];
};

type AdvertisedToolsInput = AdvertisedToolMapInput | AdvertisedToolDefinitionsInput;

export function getAdvertisedTools(input: AdvertisedToolMapInput): HarnessToolMap;
export function getAdvertisedTools(
  input: AdvertisedToolDefinitionsInput,
): readonly HarnessToolDefinition[];
export function getAdvertisedTools(
  input: AdvertisedToolsInput,
): HarnessToolMap | readonly HarnessToolDefinition[] {
  if (isToolDefinitionList(input.tools)) {
    return filterSubagentToolDefinitionsAtDepthLimit(input.tools, input.session);
  }

  return filterSubagentToolMapAtDepthLimit(input.tools, input.session);
}

function filterSubagentToolDefinitionsAtDepthLimit(
  tools: readonly HarnessToolDefinition[],
  session: Pick<HarnessSession, "subagentDepth" | "subagentMaxDepth">,
): readonly HarnessToolDefinition[] {
  const delegationLimit = resolveSubagentDelegationLimit(session);
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (delegationLimit.reached && isDelegatedRuntimeActionTool(tool)) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterSubagentToolMapAtDepthLimit(
  tools: HarnessToolMap,
  session: Pick<HarnessSession, "subagentDepth" | "subagentMaxDepth">,
): HarnessToolMap {
  const delegationLimit = resolveSubagentDelegationLimit(session);
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (delegationLimit.reached && isDelegatedRuntimeActionTool(tool)) {
      continue;
    }
    filteredTools.set(name, tool);
  }
  return filteredTools;
}

function isDelegatedRuntimeActionTool(definition: HarnessToolDefinition): boolean {
  const runtimeAction = definition.runtimeAction;
  return runtimeAction?.kind === "subagent-call" || runtimeAction?.kind === "remote-agent-call";
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
