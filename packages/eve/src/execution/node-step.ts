import type { LanguageModel } from "ai";

import type { Runtime, SessionCapabilities } from "#channel/types.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import {
  createBackgroundSubagentHarnessDefinition,
  createHarnessDelegationToolDefinition,
} from "#execution/delegation-tool.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HandleEventFn, HarnessToolMap, StepFn } from "#harness/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import { UNSPECIFIED_INPUT_SCHEMA } from "#shared/tool-schema.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  resolveRuntimeModelReference,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  AGENT_TOOL_DESCRIPTION,
  AGENT_TOOL_NAME,
  isImplicitAgentToolAvailable,
} from "#runtime/framework-tools/agent.js";
import {
  createTaskToolHarnessDefinitions,
  isTaskToolAvailable,
} from "#runtime/framework-tools/tasks.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { HistoryViewProjector, PreparedHistoryView } from "#shared/history-view.js";

import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import {
  PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#runtime/subagents/registry.js";
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
  /** Runs only a context clear and returns to the parked session. */
  readonly clearOnly?: boolean;
  /** Runs only a forced context compaction and returns to the parked session. */
  readonly compactOnly?: boolean;
  /**
   * Runtime constructor used by the subagent tool executor to start
   * delegated child runs on the same workflow runtime as the parent.
   */
  readonly createRuntime: CreateRuntime;
  readonly handleEvent?: HandleEventFn;
  readonly historyProjector?: HistoryViewProjector;
  readonly historyView?: PreparedHistoryView;
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
  const instrumentation = getInstrumentationRuntime();
  const step = createToolLoopHarness({
    abortSignal: input.abortSignal,
    capabilities: input.capabilities,
    clearOnly: input.clearOnly,
    compactOnly: input.compactOnly,
    workflow: input.node.agent.workflowTool !== undefined,
    workflowMaxSubagents: input.workflowMaxSubagents,
    webSearchProvider: input.node.agent.webSearchProvider,
    handleEvent: input.handleEvent,
    historyProjector: input.historyProjector,
    historyView: input.historyView,
    instrumentation,
    mode: input.mode,
    onCompaction: preserveFrameworkStateOnCompaction,
    persistentSubagentSessions:
      input.node.agent.config?.experimental?.tasks === true ||
      input.node.agent.config?.experimental?.subagentPersistentSessions === true,
    dispatchDynamicModelEvent: dispatchModelEvent,
    resolveModel,
    runtimeIdentity: buildRuntimeIdentity(input.node),
    tools,
  });
  if (instrumentation === undefined) return step;
  return async (session, stepInput) => {
    try {
      return await step(session, stepInput);
    } finally {
      await instrumentation.forceFlush();
    }
  };
}

/**
 * Builds a {@link RuntimeIdentity} from the resolved runtime agent node
 * and the current eve package installation.
 */
export function buildRuntimeIdentity(node: ResolvedRuntimeAgentNode): RuntimeIdentity {
  const packageInfo = resolveInstalledPackageInfo();

  const identity: RuntimeIdentity = {
    agentId: node.turnAgent.id,
    agentName: node.agent.config?.name,
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

function createRuntimeDynamicModelEventDispatcher(
  scope: RuntimeModelResolutionScope,
  dynamicModel: NonNullable<ResolvedRuntimeAgentNode["turnAgent"]["dynamicModel"]>,
): NonNullable<Parameters<typeof createToolLoopHarness>[0]["dispatchDynamicModelEvent"]> {
  return (input) =>
    dispatchDynamicModelEvent({
      ctx: input.ctx,
      dynamicModel,
      event: input.event,
      messages: input.messages,
      scope,
    });
}

/**
 * Resolves unified {@link HarnessToolDefinition}s from the node's registries.
 *
 * For authored tools: copies all lifecycle fields from the resolved definition.
 * For subagent tools: selects the existing runtime-action definition or the
 * background `defineTool` definition from the node's `experimental.tasks` setting.
 * Tools without `execute` (provider-managed) get entries with schema but no execute.
 */
export function createNodeHarnessTools(input: {
  readonly node: ResolvedRuntimeAgentNode;
}): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();
  const tasksEnabled = input.node.agent.config?.experimental?.tasks === true;

  for (const tool of input.node.turnAgent.tools) {
    const definition = resolveHarnessToolDefinition({
      node: input.node,
      tasksEnabled,
      tool,
    });

    if (definition !== null) {
      tools.set(tool.name, definition);
    }
  }

  return tools;
}

/** Framework dispatch-tool slots whose behavior the harness supplies. */
const TASK_HARNESS_DEFINITIONS = new Map(
  createTaskToolHarnessDefinitions().map((definition) => [definition.name, definition]),
);

function resolveHarnessToolDefinition(input: {
  readonly node: ResolvedRuntimeAgentNode;
  readonly tasksEnabled: boolean;
  readonly tool: PreparedRuntimeTool;
}): HarnessToolDefinition | null {
  if (input.tool.kind === "subagent" || input.tool.kind === "remote") {
    return input.tasksEnabled
      ? createBackgroundSubagentHarnessDefinition(input.tool)
      : createHarnessDelegationToolDefinition(input.tool);
  }

  // Framework dispatch slots that survived composition keep today's harness
  // behavior: the compiled row records presence and ownership, and the
  // harness supplies the delegation/task mechanics. An authored replacement
  // is application-owned and runs as an ordinary tool below.
  if (input.tool.owner?.kind === "framework") {
    if (input.tool.name === AGENT_TOOL_NAME) {
      if (
        !isImplicitAgentToolAvailable({
          nodeId: input.node.nodeId,
          tools: [input.tool],
        })
      ) {
        return null;
      }
      const implicitAgent = {
        description: AGENT_TOOL_DESCRIPTION,
        inputSchema:
          input.tasksEnabled ||
          input.node.agent.config?.experimental?.subagentPersistentSessions === true
            ? PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA
            : SUBAGENT_TOOL_INPUT_SCHEMA,
        kind: "subagent" as const,
        name: AGENT_TOOL_NAME,
        nodeId: input.node.nodeId,
        rootOnly: true,
      };
      return input.tasksEnabled
        ? createBackgroundSubagentHarnessDefinition(implicitAgent)
        : createHarnessDelegationToolDefinition(implicitAgent);
    }
    const taskDefinition = TASK_HARNESS_DEFINITIONS.get(input.tool.name);
    if (taskDefinition !== undefined) {
      return isTaskToolAvailable({
        tasksEnabled: input.tasksEnabled,
        toolName: input.tool.name,
        tools: [input.tool],
      })
        ? taskDefinition
        : null;
    }
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

  return {
    approvalKey: def.approvalKey,
    description: def.description,
    execution: def.execution,
    execute: resolveAuthoredExecute({
      rawExecute: def.execute,
      scope: def.name,
    }),
    frameworkAction:
      def.owner?.kind === "framework" && def.name === LOAD_SKILL_TOOL_NAME
        ? "load-skill"
        : undefined,
    inputSchema: def.inputSchema ?? UNSPECIFIED_INPUT_SCHEMA,
    name: def.name,
    approval: def.approval,
    outputSchema: def.outputSchema,
    toModelOutput: def.toModelOutput,
  };
}

/**
 * Selects the harness-facing `execute` for one compiled tool.
 *
 * Every executor — framework defaults included — is an ordinary public
 * executor wrapped by {@link createToolExecuteWithAuth}, which builds a
 * token-aware context. Providers passed to `ctx.getToken(provider)` use
 * tool-qualified auth scopes. Tools without `execute` (client-side or
 * provider-managed) stay `undefined`.
 */
function resolveAuthoredExecute(input: {
  readonly rawExecute: ResolvedToolDefinition["execute"];
  readonly scope: string;
}): HarnessToolDefinition["execute"] {
  const { rawExecute, scope } = input;
  if (rawExecute === undefined) {
    return undefined;
  }
  const authored = rawExecute as (
    toolInput: unknown,
    ctx: unknown,
    task?: Parameters<NonNullable<HarnessToolDefinition["execute"]>>[2],
  ) => unknown;
  return createToolExecuteWithAuth({ execute: authored, scope });
}
