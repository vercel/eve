import { jsonSchema, type FlexibleSchema, type LanguageModel } from "ai";

import type { Runtime, SessionCapabilities } from "#channel/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HandleEventFn, HarnessToolMap, StepFn } from "#harness/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import { resolveCodeModeEnabled } from "#shared/code-mode.js";
import {
  resolveRuntimeModelReference,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";

import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { preserveFrameworkStateOnCompaction } from "#execution/compaction.js";
import { buildUnauthorizedToolContext, createAuthorizedToolExecute } from "#execution/tool-auth.js";

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
}

/**
 * Builds a harness step for one resolved runtime node using the execution-owned
 * tool, sandbox, and subagent wiring.
 */
export function createExecutionNodeStep(input: CreateExecutionNodeStepInput): StepFn {
  const resolveModel = createRuntimeModelResolver(input.modelResolutionScope);
  const tools = createNodeHarnessTools({ node: input.node });
  return createToolLoopHarness({
    capabilities: input.capabilities,
    codeMode: resolveCodeModeEnabled(input.node.agent.config?.experimental?.codeMode),
    workflow: input.node.agent.workflowEnabled === true,
    handleEvent: input.handleEvent,
    mode: input.mode,
    onCompaction: preserveFrameworkStateOnCompaction,
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
    modelId: node.turnAgent.model.id,
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

  if (!tools.has("agent")) {
    tools.set("agent", {
      description: "Launch a new agent to handle a complex, multi-step subtask.",
      inputSchema: jsonSchema(SUBAGENT_TOOL_INPUT_SCHEMA),
      name: "agent",
      runtimeAction: {
        kind: "subagent-call",
        nodeId: input.node.nodeId,
        subagentName: "agent",
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
      auth: def.auth,
      isFrameworkTool,
      rawExecute,
      scope: def.name,
    }),
    inputSchema: def.inputStandardSchema ?? jsonSchema(def.inputSchema ?? {}),
    name: def.name,
    needsApproval: def.needsApproval,
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
 * - Tools that declare `auth` are wrapped by
 *   {@link createAuthorizedToolExecute}, which builds a token-aware
 *   context and drives the interactive consent flow scoped to the tool
 *   name.
 * - Plain authored tools receive a freshly built callback context.
 * - Tools without `execute` (provider-managed) stay `undefined`.
 */
function resolveAuthoredExecute(input: {
  readonly auth: ResolvedToolDefinition["auth"];
  readonly isFrameworkTool: boolean;
  readonly rawExecute: ResolvedToolDefinition["execute"];
  readonly scope: string;
}): HarnessToolDefinition["execute"] {
  const { auth, isFrameworkTool, rawExecute, scope } = input;
  if (rawExecute === undefined) {
    return undefined;
  }
  if (isFrameworkTool) {
    return rawExecute;
  }
  const authored = rawExecute as (toolInput: unknown, ctx: unknown) => unknown;
  if (auth !== undefined) {
    return createAuthorizedToolExecute({ auth, execute: authored, scope });
  }
  return (toolInput: unknown) => authored(toolInput, buildUnauthorizedToolContext(scope));
}

function maybeJsonSchema(
  schema: ResolvedToolDefinition["outputSchema"],
): FlexibleSchema | undefined {
  return schema === undefined ? undefined : jsonSchema(schema);
}
