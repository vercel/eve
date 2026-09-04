import type { LanguageModel } from "ai";

import type { Runtime, SessionCapabilities } from "#channel/types.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { preparePersistedStepDynamicToolMetadata } from "#context/dynamic-tool-lifecycle.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HandleEventFn, HarnessToolMap, StepFn } from "#harness/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import { UNSPECIFIED_INPUT_SCHEMA } from "#tools/schema.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  resolveRuntimeModelReference,
  type RuntimeModelResolutionScope,
} from "#runtime/agent/resolve-model.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createTaskToolHarnessDefinitions } from "#execution/tools/tasks.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { HistoryViewProjector, PreparedHistoryView } from "#shared/history-view.js";
import type { PreparedRuntimeTool, PreparedRuntimeWorkflowTask } from "#runtime/sessions/turn.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { preserveFrameworkStateOnCompaction } from "#execution/compaction.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { ASK_QUESTION_TOOL_NAME } from "#harness/request-input-tool.js";
import {
  createPreparedWorkflowToolHarnessDefinition,
  createWorkflowToolHarnessDefinition,
} from "#execution/tools/workflow/background.js";

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
  /** Restores model history and returns to the parked session. */
  readonly restoreHistoryTo?: number;
  /**
   * Runtime constructor used by the subagent tool executor to start
   * delegated child runs on the same workflow runtime as the parent.
   */
  readonly createRuntime: CreateRuntime;
  readonly handleEvent?: HandleEventFn;
  readonly beforeResponseRelease?: Parameters<
    typeof createToolLoopHarness
  >[0]["beforeResponseRelease"];
  readonly historyProjector?: HistoryViewProjector;
  readonly historyView?: PreparedHistoryView;
  readonly instrumentation: ExecutionInstrumentation | undefined;
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
  const instrumentation = input.instrumentation;
  const sessionInstrumentation = instrumentation?.prepareExecution();
  const step = createToolLoopHarness({
    abortSignal: input.abortSignal,
    capabilities: input.capabilities,
    clearOnly: input.clearOnly,
    compactOnly: input.compactOnly,
    restoreHistoryTo: input.restoreHistoryTo,
    workflow: input.node.agent.workflowTool !== undefined,
    workflowMaxSubagents: input.workflowMaxSubagents,
    beforeResponseRelease: input.beforeResponseRelease,
    handleEvent: input.handleEvent,
    historyProjector: input.historyProjector,
    historyView: input.historyView,
    instrumentation: sessionInstrumentation,
    mode: input.mode,
    onCompaction: preserveFrameworkStateOnCompaction,
    resolveStepDynamicTools: (resolveInput) =>
      preparePersistedStepDynamicToolMetadata({
        ...resolveInput,
        resolvers: input.node.agent.dynamicToolResolvers ?? [],
      }),
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
      await instrumentation.flush();
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
 * Prepared workflow-task tools share the workflow-tool harness path.
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

  return tools;
}

function resolveHarnessToolDefinition(input: {
  readonly node: ResolvedRuntimeAgentNode;
  readonly tool: PreparedRuntimeTool;
}): HarnessToolDefinition | null {
  const registeredTool = findRegisteredRuntimeTool(input.node.toolRegistry, input.tool.name);

  if (isPreparedRuntimeWorkflowTool(input.tool)) {
    if (registeredTool === null) {
      return createPreparedWorkflowToolHarnessDefinition(input.tool);
    }
    return createWorkflowToolHarnessDefinition({
      definition: createRegisteredHarnessToolDefinition({
        behavior: input.tool.behavior,
        definition: registeredTool.definition,
        rootOnly: input.tool.rootOnly,
      }),
      nodeId: input.tool.task.nodeId,
      resultKind: input.tool.task.resultKind,
      workflowId: input.tool.task.workflowId,
    });
  }

  if (registeredTool === null) {
    // Declared on the graph but absent from the registry (failed import, renamed export).
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

type PreparedRuntimeWorkflowTool = PreparedRuntimeTool & {
  readonly task: PreparedRuntimeWorkflowTask;
};

function isPreparedRuntimeWorkflowTool(
  tool: PreparedRuntimeTool,
): tool is PreparedRuntimeWorkflowTool {
  return tool.task !== undefined;
}

function createRegisteredHarnessToolDefinition(input: {
  readonly behavior?: HarnessToolDefinition["behavior"];
  readonly definition: ResolvedToolDefinition;
  readonly rootOnly?: boolean;
}): HarnessToolDefinition {
  const def = input.definition;
  if (def.owner.kind === "framework") {
    const taskDefinition = createTaskToolHarnessDefinitions().find(
      (definition) => definition.name === def.name,
    );
    if (taskDefinition !== undefined) {
      return { ...taskDefinition, behavior: input.behavior };
    }
  }
  const rawExecute = def.execute;
  const isFrameworkRequestInput =
    def.owner.kind === "framework" && def.name === ASK_QUESTION_TOOL_NAME;

  const definition: HarnessToolDefinition = {
    approvalKey: def.approvalKey,
    behavior: input.behavior,
    description: def.description,
    execution: def.execution,
    execute: isFrameworkRequestInput
      ? undefined
      : resolveAuthoredExecute({
          rawExecute,
          scope: def.name,
        }),
    frameworkAction:
      def.owner.kind === "framework" && def.name === LOAD_SKILL_TOOL_NAME
        ? "load-skill"
        : undefined,
    inputSchema: def.inputSchema ?? UNSPECIFIED_INPUT_SCHEMA,
    name: def.name,
    approval: def.approval,
    outputSchema: def.outputSchema,
    rootOnly: input.rootOnly,
    toModelOutput: def.toModelOutput,
  };
  return definition;
}

/**
 * Selects the harness-facing `execute` for one authored tool.
 *
 * - Source-backed tools are wrapped by {@link createToolExecuteWithAuth},
 *   which builds a token-aware context. Providers passed to
 *   `ctx.getToken(provider)` use tool-qualified auth scopes.
 * - Tools without `execute` (provider-managed) stay `undefined`.
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
