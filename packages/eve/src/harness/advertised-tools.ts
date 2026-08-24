import type { ToolSet } from "ai";
import type { SessionCapabilities } from "#channel/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { isKernelCapabilityAdvertised, type KernelCapabilityPlan } from "#kernel/capabilities.js";
import { useAdvertisedKernelWorkflow } from "#kernel/executable-capabilities.js";
import {
  ensureWorkflowContinuationSecurity,
  getWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { WorkflowSandboxLifecycle } from "#shared/workflow-sandbox.js";

type AdvertisedToolSession = Pick<HarnessSession, "rootSessionId" | "subagentDepth">;

type AdvertisedToolMapInput = {
  readonly capabilities?: SessionCapabilities;
  readonly delegatedCaller?: boolean;
  readonly kernelPlan: KernelCapabilityPlan;
  readonly modelSupportsProviderTools?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: HarnessToolMap;
};

type AdvertisedToolDefinitionsInput = {
  readonly capabilities?: SessionCapabilities;
  readonly delegatedCaller?: boolean;
  readonly kernelPlan: KernelCapabilityPlan;
  readonly modelSupportsProviderTools?: boolean;
  readonly session: AdvertisedToolSession;
  readonly tools: readonly HarnessToolDefinition[];
};

type AdvertisedModelToolsInput = {
  readonly capabilities?: SessionCapabilities;
  readonly delegatedCaller?: boolean;
  readonly kernelPlan: KernelCapabilityPlan;
  readonly modelSupportsProviderTools?: boolean;
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
      input.capabilities,
      input.kernelPlan,
      input.modelSupportsProviderTools,
    );
  }

  return filterUnavailableKernelToolMap(
    input.tools,
    input.session,
    input.delegatedCaller,
    input.capabilities,
    input.kernelPlan,
    input.modelSupportsProviderTools,
  );
}

async function getAdvertisedModelTools(
  input: AdvertisedModelToolsInput,
): Promise<AdvertisedModelTools> {
  const tools = filterUnavailableKernelToolMap(
    input.tools,
    input.session,
    input.delegatedCaller,
    input.capabilities,
    input.kernelPlan,
    input.modelSupportsProviderTools,
  );
  const depth = resolveSubagentDepth(input.session).currentDepth;
  const workflowAdvertised =
    useAdvertisedKernelWorkflow(
      input.kernelPlan,
      {
        delegatedCaller: input.delegatedCaller,
        modelSupportsProviderTools: input.modelSupportsProviderTools,
        requestInput: input.capabilities?.requestInput,
        rootSession: input.session.rootSessionId === undefined,
        subagentDepth: depth,
      },
      () => true,
    ) === true;
  if (input.workflow === undefined || !workflowAdvertised) {
    return {
      harnessTools: tools,
      modelTools: input.modelTools,
      session: input.session,
    };
  }

  const workflowHostTools = filterWorkflowHostTools(tools);
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
  capabilities: SessionCapabilities | undefined,
  kernelPlan: KernelCapabilityPlan,
  modelSupportsProviderTools: boolean | undefined,
): readonly HarnessToolDefinition[] {
  const filteredTools: HarnessToolDefinition[] = [];

  for (const tool of tools) {
    if (
      shouldHideKernelTool(
        tool,
        session,
        delegatedCaller,
        capabilities,
        kernelPlan,
        modelSupportsProviderTools,
      )
    ) {
      continue;
    }
    filteredTools.push(tool);
  }
  return filteredTools;
}

function filterUnavailableKernelToolMap(
  tools: HarnessToolMap,
  session: AdvertisedToolSession,
  delegatedCaller: boolean | undefined,
  capabilities: SessionCapabilities | undefined,
  kernelPlan: KernelCapabilityPlan,
  modelSupportsProviderTools: boolean | undefined,
): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (
      shouldHideKernelTool(
        tool,
        session,
        delegatedCaller,
        capabilities,
        kernelPlan,
        modelSupportsProviderTools,
      )
    ) {
      continue;
    }
    filteredTools.set(name, tool);
  }
  return filteredTools;
}

function filterWorkflowHostTools(tools: HarnessToolMap): HarnessToolMap {
  const filteredTools = new Map<string, HarnessToolDefinition>();

  for (const [name, tool] of tools) {
    if (tool.workflowCallable === true) {
      filteredTools.set(name, tool);
    }
  }
  return filteredTools;
}

function shouldHideKernelTool(
  definition: HarnessToolDefinition,
  session: AdvertisedToolSession,
  delegatedCaller: boolean | undefined,
  capabilities: SessionCapabilities | undefined,
  kernelPlan: KernelCapabilityPlan,
  modelSupportsProviderTools: boolean | undefined,
): boolean {
  const name = definition.kernelCapability;
  if (name === undefined) return false;
  const depth = resolveSubagentDepth(session).currentDepth;
  return !isKernelCapabilityAdvertised(kernelPlan, name, {
    delegatedCaller,
    modelSupportsProviderTools: modelSupportsProviderTools === true,
    requestInput: capabilities?.requestInput,
    rootSession: session.rootSessionId === undefined,
    structuredOutput: false,
    subagentDepth: depth,
  });
}

function isToolDefinitionList(
  tools: HarnessToolMap | readonly HarnessToolDefinition[],
): tools is readonly HarnessToolDefinition[] {
  return Array.isArray(tools);
}
