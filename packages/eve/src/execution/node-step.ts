import type { LanguageModel } from "ai";
import { isFrameworkTool, isInteractionOnly } from "#tools/provided/framework-tool.js";

import type { Runtime, SessionCapabilities } from "#channel/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import { createKernel } from "#harness/kernel.js";
import type { HandleEventFn, HarnessToolMap, StepFn } from "#harness/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/session-events/families/session.js";
import { UNSPECIFIED_INPUT_SCHEMA } from "#tools/schema.js";
import {
  resolveRuntimeModelReference,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { workflowIdForHandling } from "#runtime/subagents/workflow-reference.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  createPreparedWorkflowToolHarnessDefinition,
  createWorkflowToolHarnessDefinition,
} from "#execution/tools/workflow/harness-definition.js";
import {
  resolveWebSearchActivityLabel,
  WEB_SEARCH_TOOL_NAME,
} from "#harness/provider-tool-schemas.js";
import type { KernelConfig } from "#harness/types.js";

const log = createLogger("execution.node-step");

export type CreateRuntime = (config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}) => Runtime;

interface CreateExecutionNodeStepInput {
  readonly steeringSignal?: AbortSignal;
  readonly abortSignal?: AbortSignal;
  readonly capabilities?: SessionCapabilities;
  readonly clearOnly?: boolean;
  readonly compactOnly?: boolean;
  readonly controlDelivery?: KernelConfig["controlDelivery"];
  readonly createRuntime: CreateRuntime;
  readonly handleEvent?: HandleEventFn;
  readonly signInCompletions?: KernelConfig["signInCompletions"];
  readonly typedAnswers?: KernelConfig["typedAnswers"];
  readonly instrumentation: ExecutionInstrumentation | undefined;
  readonly setAttributes?: KernelConfig["setAttributes"];
  readonly modelResolutionScope: RuntimeModelResolutionScope;
  readonly agent: RuntimeAgentIdentity;
  readonly node: ResolvedRuntimeAgentNode;
  readonly sessionUsageLimit?: KernelConfig["sessionUsageLimit"];
}

export function createExecutionNodeStep(input: CreateExecutionNodeStepInput): StepFn {
  const resolveModel = createRuntimeModelResolver(input.modelResolutionScope);
  const tools = createNodeHarnessTools({ node: input.node });
  const instrumentation = input.instrumentation;
  const sessionInstrumentation = instrumentation?.prepareExecution();
  const step = createKernel({
    steeringSignal: input.steeringSignal,
    abortSignal: input.abortSignal,
    capabilities: input.capabilities,
    clearOnly: input.clearOnly,
    compactOnly: input.compactOnly,
    controlDelivery: input.controlDelivery,
    handleEvent: input.handleEvent,
    instrumentation: sessionInstrumentation,
    signInCompletions: input.signInCompletions,
    typedAnswers: input.typedAnswers,
    resolveModel,
    runtimeIdentity: buildRuntimeIdentity(input.agent),
    sessionUsageLimit: input.sessionUsageLimit,
    tools,
    setAttributes: input.setAttributes,
  });
  if (instrumentation === undefined) return step;
  return async (session, stepInput) => {
    try {
      return await step(session, stepInput);
    } finally {
      await instrumentation.flush();
    }
  };
}

export interface RuntimeAgentIdentity {
  readonly id: string;
  readonly name?: string;
}

export function buildRuntimeIdentity(agent: RuntimeAgentIdentity): RuntimeIdentity {
  const packageInfo = resolveInstalledPackageInfo();

  const identity: RuntimeIdentity = {
    agentId: agent.id,
    agentName: agent.name,
    eveVersion: packageInfo.version,
  };

  const gitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const gitBranch = process.env.VERCEL_GIT_COMMIT_REF?.trim();
  const deployedAt = process.env.VERCEL_DEPLOYMENT_CREATED_AT?.trim();

  if (gitSha || gitBranch || deployedAt) {
    return {
      ...identity,
      build: {
        deployedAt: deployedAt || undefined,
        gitBranch: gitBranch || undefined,
        gitSha: gitSha || undefined,
      },
    };
  }

  return identity;
}

function createRuntimeModelResolver(
  scope: RuntimeModelResolutionScope,
): (modelReference: Parameters<typeof resolveRuntimeModelReference>[0]) => Promise<LanguageModel> {
  return (modelReference) => resolveRuntimeModelReference(modelReference, scope);
}

export function createNodeHarnessTools(input: {
  readonly node: ResolvedRuntimeAgentNode;
}): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();

  for (const tool of input.node.turnAgent.tools) {
    const definition = resolveHarnessToolDefinition({
      node: input.node,
      tool,
    });

    if (definition !== null) {
      tools.set(tool.name, definition);
    }
  }

  return tools;
}

function resolveHarnessToolDefinition(input: {
  readonly node: ResolvedRuntimeAgentNode;
  readonly tool: PreparedRuntimeTool;
}): HarnessToolDefinition | null {
  const registeredTool = findRegisteredRuntimeTool(input.node.toolRegistry, input.tool.name);
  const workflowId = workflowIdForHandling(input.tool.behavior?.handling);

  if (workflowId !== undefined) {
    if (registeredTool === null) {
      return createPreparedWorkflowToolHarnessDefinition(input.tool);
    }
    return createWorkflowToolHarnessDefinition({
      executeInput: registeredTool.definition.executeInput,
      definition: createRegisteredHarnessToolDefinition({
        behavior: input.tool.behavior,
        definition: registeredTool.definition,
        rootOnly: input.tool.rootOnly,
      }),
      workflowId,
    });
  }

  if (registeredTool === null) {
    log.warn("declared tool is not registered — omitting from toolset", {
      toolName: input.tool.name,
      nodeId: input.node.nodeId,
    });
    return null;
  }

  return createRegisteredHarnessToolDefinition({
    behavior: input.tool.behavior,
    definition: registeredTool.definition,
    rootOnly: input.tool.rootOnly,
  });
}

function createRegisteredHarnessToolDefinition(input: {
  readonly behavior?: HarnessToolDefinition["behavior"];
  readonly definition: ResolvedToolDefinition;
  readonly rootOnly?: boolean;
}): HarnessToolDefinition {
  const def = input.definition;
  const rawExecute = def.execute;

  const definition: HarnessToolDefinition = {
    availableInSubagents: def.availableInSubagents,
    label:
      def.label ??
      (def.owner.kind === "framework" && def.name === WEB_SEARCH_TOOL_NAME
        ? { start: resolveWebSearchActivityLabel }
        : undefined),
    behavior: input.behavior,
    deferred: def.deferred,
    description: def.description,
    endsTurn: def.endsTurn,
    executeInput: def.executeInput,
    execute: resolveAuthoredExecute({
      rawExecute,
      scope: def.name,
    }),
    frameworkTool: isFrameworkTool(def) || def.owner.kind === "framework",
    inputSchema: def.inputSchema ?? UNSPECIFIED_INPUT_SCHEMA,
    ...(isInteractionOnly(def) && { interactionOnly: true }),
    name: def.name,
    approval: def.approval,
    outputSchema: def.outputSchema,
    rootOnly: input.rootOnly,
    toModelOutput: def.toModelOutput,
  };
  return definition;
}

function resolveAuthoredExecute(input: {
  readonly rawExecute: ResolvedToolDefinition["execute"];
  readonly scope: string;
}): HarnessToolDefinition["execute"] {
  const { rawExecute, scope } = input;
  if (rawExecute === undefined) {
    return undefined;
  }
  const authored = rawExecute as (toolInput: unknown, ctx: unknown) => unknown;
  return createToolExecuteWithAuth({ execute: authored, scope });
}
