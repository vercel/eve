import { jsonSchema, type FlexibleSchema, type LanguageModel } from "ai";

import type { Runtime, SessionCapabilities } from "#channel/types.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HandleEventFn, HarnessToolMap, StepFn } from "#harness/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  resolveRuntimeModelReference,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#runtime/framework-tools/agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedRuntimeAgentNode } from "#runtime/graph.js";

import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { preserveFrameworkStateOnCompaction } from "#execution/compaction.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";

const log = createLogger("execution.node-step");

/**
 * Factory that creates a {@link Runtime} for the given compiled
 * artifacts source and optional node id. Matches the signature of
 * `createWorkflowRuntime`, so callers pass the constructor directly —
 * no wrapper needed.
 */
export type CreateRuntime = (config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}) => Runtime;

/**
 * Input for building a harness step for one resolved runtime node.
 */
export interface CreateExecutionNodeStepInput {
  /** Cancellation signal forwarded to the tool-loop harness. */
  readonly abortSignal?: AbortSignal;
  /**
   * Session-level capabilities propagated from the runtime. The
   * harness passes this through to `buildToolSet` so `ask_question`
   * registration and any other capability-gated behavior tracks the
   * current run.
   */
  readonly capabilities?: SessionCapabilities;
  /**
   * Runtime constructor used by the subagent tool executor to start
   * delegated child runs on the same workflow runtime as the parent.
   */
  readonly createRuntime: CreateRuntime;
  readonly handleEvent?: HandleEventFn;
  readonly mode: RunMode;
  readonly modelResolutionScope: RuntimeModelResolutionScope;
  readonly node: ResolvedRuntimeAgentNode;
  /**
   * Effective `maxSubagents` cap configured by the experimental Workflow tool
   * definition and materialized on the session at creation.
   */
  readonly workflowMaxSubagents?: number;
}

/**
 * Builds a harness step for one resolved runtime node using the execution-owned
 * tool, sandbox, and subagent wiring.
 */
export function createExecutionNodeStep(input: CreateExecutionNodeStepInput): StepFn {
  const resolveModel = createRuntimeModelResolver(input.modelResolutionScope);
  const dispatchModelEvent =
    input.node.turnAgent.dynamicModel === undefined
      ? undefined
      : createRuntimeDynamicModelEventDispatcher(
          input.modelResolutionScope,
          input.node.turnAgent.dynamicModel,
        );
  const tools = createNodeHarnessTools({ node: input.node });
  return createToolLoopHarness({
    abortSignal: input.abortSignal,
    capabilities: input.capabilities,
    workflow: input.node.agent.workflowTool !== undefined,
    workflowMaxSubagents: input.workflowMaxSubagents,
    handleEvent: input.handleEvent,
    mode: input.mode,
    onCompaction: preserveFrameworkStateOnCompaction,
    dispatchDynamicModelEvent: dispatchModelEvent,
    resolveModel,
    runtimeIdentity: buildRuntimeIdentity(input.node),
    tools,
  });
}

/**
 * Builds a {@link RuntimeIdentity} from the resolved runtime agent node
 * and the current eve package installation.
 */
function buildRuntimeIdentity(node: ResolvedRuntimeAgentNode): RuntimeIdentity {
  const packageInfo = resolveInstalledPackageInfo();

  const identity: RuntimeIdentity = {
    agentId: node.turnAgent.id,
    agentName: node.agent.config?.name,
    eveVersion: packageInfo.version,
    modelId:
      node.turnAgent.dynamicModel === undefined
        ? node.turnAgent.model.id
        : `dynamic:${node.turnAgent.model.id}`,
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

function createRuntimeDynamicModelEventDispatcher(
  scope: RuntimeModelResolutionScope,
  dynamicModel: NonNullable<ResolvedRuntimeAgentNode["turnAgent"]["dynamicModel"]>,
): NonNullable<Parameters<typeof createToolLoopHarness>[0]["dispatchDynamicModelEvent"]> {
  return (input) =>
    dispatchDynamicModelEvent({
      ctx: input.ctx,
      dynamicModel,
      event: input.event,
      fallback: input.fallback,
      messages: input.messages,
      scope,
    });
}

/**
 * Resolves unified {@link HarnessToolDefinition}s from the node's registries.
 *
 * For authored tools: copies all lifecycle fields from the resolved definition.
 * For subagent tools: surfaces runtime-owned subagent-call metadata and leaves
 * execution to the runtime layer.
 * Tools without `execute` (provider-managed) get entries with schema but no execute.
 */
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

  if (
    input.node.nodeId === ROOT_RUNTIME_AGENT_NODE_ID &&
    !input.node.agent.disabledFrameworkTools.includes(AGENT_TOOL_NAME) &&
    !tools.has(AGENT_TOOL_NAME)
  ) {
    tools.set(AGENT_TOOL_NAME, {
      description: AGENT_TOOL_DESCRIPTION,
      inputSchema: jsonSchema(SUBAGENT_TOOL_INPUT_SCHEMA),
      name: AGENT_TOOL_NAME,
      runtimeAction: {
        kind: "subagent-call",
        nodeId: input.node.nodeId,
        subagentName: AGENT_TOOL_NAME,
      },
    });
  }

  return tools;
}

function resolveHarnessToolDefinition(input: {
  readonly node: ResolvedRuntimeAgentNode;
  readonly tool: PreparedRuntimeTool;
}): HarnessToolDefinition | null {
  if (input.tool.kind === "subagent") {
    return {
      description: input.tool.description ?? "",
      inputSchema: jsonSchema(input.tool.inputSchema ?? {}),
      name: input.tool.name,
      outputSchema:
        input.tool.outputSchema === undefined ? undefined : jsonSchema(input.tool.outputSchema),
      runtimeAction: {
        kind: "subagent-call",
        nodeId: input.tool.nodeId,
        subagentName: input.tool.name,
      },
    };
  }

  if (input.tool.kind === "remote") {
    return {
      description: input.tool.description ?? "",
      inputSchema: jsonSchema(input.tool.inputSchema ?? {}),
      name: input.tool.name,
      outputSchema:
        input.tool.outputSchema === undefined ? undefined : jsonSchema(input.tool.outputSchema),
      runtimeAction: {
        kind: "remote-agent-call",
        nodeId: input.tool.nodeId,
        remoteAgentName: input.tool.name,
        subagentName: input.tool.name,
      },
    };
  }

  const registeredTool = findRegisteredRuntimeTool(input.node.toolRegistry, input.tool.name);

  if (registeredTool === null) {
    // Declared on the graph but absent from the registry (failed import, renamed export).
    log.warn("declared tool is not registered — omitting from toolset", {
      toolName: input.tool.name,
      nodeId: input.node.nodeId,
    });
    return null;
  }

  const def = registeredTool.definition;
  const isFrameworkTool = def.sourceId.startsWith("eve:");
  const rawExecute = def.execute;

  return {
    approvalKey: def.approvalKey,
    description: def.description,
    execute: resolveAuthoredExecute({
      isFrameworkTool,
      rawExecute,
      scope: def.name,
    }),
    inputSchema: def.inputStandardSchema ?? jsonSchema(def.inputSchema ?? {}),
    name: def.name,
    approval: def.approval,
    outputSchema: def.outputStandardSchema ?? maybeJsonSchema(def.outputSchema),
    toModelOutput: def.toModelOutput,
  };
}

/**
 * Selects the harness-facing `execute` for one authored tool.
 *
 * - Framework tools (`eve:` source) run their `execute` verbatim — they
 *   manage their own context and never receive an authored
 *   {@link ToolContext}.
 * - Authored tools are wrapped by {@link createToolExecuteWithAuth},
 *   which builds a token-aware context. Providers passed to
 *   `ctx.getToken(provider)` use tool-qualified auth scopes.
 * - Tools without `execute` (provider-managed) stay `undefined`.
 */
function resolveAuthoredExecute(input: {
  readonly isFrameworkTool: boolean;
  readonly rawExecute: ResolvedToolDefinition["execute"];
  readonly scope: string;
}): HarnessToolDefinition["execute"] {
  const { isFrameworkTool, rawExecute, scope } = input;
  if (rawExecute === undefined) {
    return undefined;
  }
  if (isFrameworkTool) {
    return rawExecute;
  }
  const authored = rawExecute as (toolInput: unknown, ctx: unknown) => unknown;
  return createToolExecuteWithAuth({ execute: authored, scope });
}

function maybeJsonSchema(
  schema: ResolvedToolDefinition["outputSchema"],
): FlexibleSchema | undefined {
  return schema === undefined ? undefined : jsonSchema(schema);
}
