import { randomBytes } from "node:crypto";

import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import { getChannelActivityPresentation } from "#channel/activity-renderer.js";
import type {
  CancelTurnInput,
  CancelTurnResult,
  DispatchContinuationInput,
  DispatchSessionInput,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { ActivityObserverKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  cancelRun,
  getHookByToken,
  getRun,
  getWorld,
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import type { WorkflowEntryInput } from "#execution/workflow-entry.js";
import type { ActivityCollectorInput } from "#execution/activity-collector.js";
import { createEveActivityRoutePath } from "#protocol/routes.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import { walkCauseChain } from "#shared/errors.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { isAgentTraceContext } from "#tracing/agent-trace-context.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { initializeSessionInstrumentation } from "#instrumentation/runtime.js";
import {
  ACTIVITY_COLLECTOR_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  TASK_RUN_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  TURN_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
} from "#execution/stable-workflow-names.js";
const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const COMMAND_HOOK_READY_TIMEOUT_MS = 30_000;
const DEFAULT_ACTIVITY_COLLECTOR_RETENTION_MS = 24 * 60 * 60 * 1_000;

const STABLE_ID_BASE = EVE_PACKAGE_INFO.name;

const log = createLogger("execution.workflow-runtime");

interface WorkflowHookRecord {
  readonly runId: string;
}

/**
 * Stable workflow reference used by `start()` to locate the workflow
 * entrypoint registered by the Workflow DevKit builder. The id omits
 * the package version stamp so the long-lived driver can rotate across
 * deployments without rewriting the registry key.
 */
export const workflowEntryReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_ENTRY_NAME}`,
};

/**
 * Stable workflow reference used by the driver to dispatch per-turn
 * child workflow runs. The id omits the package version stamp so an
 * explicitly stamped accepting deployment can resolve the workflow even
 * when its eve version differs from the driver's deployment.
 */
export const turnWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${TURN_WORKFLOW_NAME}`,
};

/** Stable workflow reference for session deadline timers. */
export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

/** Stable workflow reference for durable task runs (`experimental.tasks`). */
export const taskRunWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${TASK_RUN_WORKFLOW_NAME}`,
};

/** Stable workflow reference for root-session activity collectors. */
export const activityCollectorWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${ACTIVITY_COLLECTOR_WORKFLOW_NAME}`,
};

/** Stable workflow reference for authored workflow tool runs. */
export const workflowToolRunWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`,
};

export { subagentToolExecuteWorkflowReference } from "#execution/tools/subagent/workflow-reference.js";

/**
 * Creates a workflow-backed runtime whose long-lived driver owns the
 * event stream and dispatches each turn as a child workflow run.
 */
export function createWorkflowRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}): Runtime {
  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
      });
      const ctx = buildRunContext({
        bundle,
        dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
        run: input,
      });
      const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
      initializeSessionInstrumentation({
        agentName: effectiveAgent.turnAgent.id,
        ctx,
        parentTraceContext: input.parentTraceContext,
      });
      const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
      let collectorRunId: string | undefined;
      let activityObserver = input.activityObserver;
      if (
        input.parent === undefined &&
        activityObserver === undefined &&
        (getChannelActivityPresentation(input.adapter)?.renderers.length ?? 0) > 0
      ) {
        const collectorContext = serializeContext(ctx);
        const token = randomBytes(32).toString("base64url");
        const collectorInput: ActivityCollectorInput = {
          expiresAt: new Date(
            Date.now() +
              (typeof sessionTimeoutMs === "number"
                ? sessionTimeoutMs
                : DEFAULT_ACTIVITY_COLLECTOR_RETENTION_MS),
          ).toISOString(),
          serializedContext: collectorContext,
          token,
        };
        try {
          const collector = await startWorkflowOnCurrentDeployment(
            activityCollectorWorkflowReference,
            [collectorInput],
          );
          collectorRunId = collector.runId;
          const fallbackOrigin = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : "http://localhost:3000";
          const baseUrl = resolveWorkflowCallbackBaseUrl(fallbackOrigin);
          activityObserver = {
            sink: {
              url: createWorkflowCallbackUrl(baseUrl, createEveActivityRoutePath(token)),
              version: 1,
            },
          };
          ctx.set(ActivityObserverKey, activityObserver);
        } catch {
          await cancelActivityCollector(collectorRunId);
          collectorRunId = undefined;
          log.warn("failed to start activity collector");
        }
      }
      const serializedContext = serializeContext(ctx);
      const parentLineage = readParentLineage(serializedContext);
      const workflowInput: {
        -readonly [K in keyof WorkflowEntryInput]: WorkflowEntryInput[K];
      } = {
        input: input.input,
        limits: input.limits,
        serializedContext,
      };
      if (collectorRunId !== undefined) {
        workflowInput.activityCollectorRunId = collectorRunId;
      }
      if (input.continuationConflictCommand !== undefined) {
        workflowInput.continuationConflictCommand = input.continuationConflictCommand;
      }
      if (sessionTimeoutMs !== undefined) {
        workflowInput.sessionTimeoutMs = sessionTimeoutMs;
      }
      const sessionAttributes =
        parentLineage.sessionId === undefined
          ? buildSessionAttributes({
              inputMessage: input.title ?? input.input.message,
              serializedContext,
            })
          : buildSubagentRootAttributes({
              identity: { nodeId: bundle.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID },
              parentCallId: parentLineage.callId,
              parentSessionId: parentLineage.sessionId,
              parentTurnId: parentLineage.turnId,
              rootSessionId: parentLineage.rootSessionId ?? parentLineage.sessionId,
              serializedContext,
            });
      const attributes = {
        ...sessionAttributes,
        ...(input.externalInvocation === undefined
          ? {}
          : buildInvocationAttributes(input.externalInvocation)),
      };

      let run: Awaited<ReturnType<typeof startWorkflowOnCurrentDeployment>>;
      try {
        run = await startWorkflowOnCurrentDeployment(workflowEntryReference, [workflowInput], {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(attributes),
        });
      } catch (error) {
        await cancelActivityCollector(collectorRunId);
        logError(log, "failed to start workflow run", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }

      let events: ReadableStream<MessageStreamEvent> | undefined;
      const getEvents = () => {
        events ??= parseNdjsonStream<MessageStreamEvent>(() => getRun(run.runId).getReadable());
        return events;
      };

      return {
        get events() {
          return getEvents();
        },
        sessionId: run.runId,
      };
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowCommand(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowCommand(sessionCommandHookToken(input.sessionId), input.command);
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<MessageStreamEvent>> {
      return parseNdjsonStream<MessageStreamEvent>(() =>
        getRun(sessionId).getReadable({ startIndex: options?.startIndex }),
      );
    },

    async getStreamTailIndex(sessionId: string): Promise<number> {
      // The readable is never consumed; cancel it so the unread source does not linger.
      const readable = getRun(sessionId).getReadable();
      try {
        return await readable.getTailIndex();
      } finally {
        await readable.cancel().catch(() => {});
      }
    },

    async resolveContinuation(
      continuationToken: string,
    ): Promise<{ sessionId: string } | undefined> {
      try {
        const hook = await getHookByToken(continuationToken);
        return { sessionId: hook.runId };
      } catch (error) {
        if (HookNotFoundError.is(error)) {
          return undefined;
        }
        logError(log, "failed to resolve session by continuation token", error, {
          continuationToken,
        });
        throw error;
      }
    },
  };
}

async function cancelActivityCollector(runId: string | undefined): Promise<void> {
  if (runId === undefined) return;
  try {
    await cancelRun(await getWorld(), runId, {
      cancelReason: "Root session creation did not complete",
    });
  } catch {
    log.warn("failed to cancel unowned activity collector");
  }
}

async function dispatchWorkflowCommand<TCommand extends SessionCommand>(
  token: string,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  let hook: WorkflowHookRecord;
  try {
    hook = normalizeWorkflowHook(await resumeSessionInbox(token, command));
  } catch (error) {
    if (isInactiveCommandTarget(error)) {
      return inactiveCommandResult(command);
    }
    logError(log, "failed to dispatch session command", error, {
      command: command.kind,
      token,
    });
    throw error;
  }

  if (command.kind === "reset") {
    await waitForCommandHookRelease(sessionCommandHookToken(hook.runId), hook.runId);
  }

  return activeCommandResult(command, hook.runId);
}

function activeCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  sessionId: string,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "reset"
      ? { previousSessionId: sessionId, status: "reset" as const }
      : command.kind === "cancel"
        ? { sessionId, status: "accepted" as const }
        : { sessionId, status: "accepted" as const };
  return result as SessionCommandResult<TCommand>;
}

function inactiveCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "send"
      ? { status: "session_not_active" as const }
      : command.kind === "cancel"
        ? { status: "no_active_turn" as const }
        : { status: "no_active_session" as const };
  return result as SessionCommandResult<TCommand>;
}

/** Requests cancellation through a session's stable command inbox. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  const command: { kind: "cancel"; taskId?: string; turnId?: string } = {
    kind: "cancel",
  };
  if (input.taskId !== undefined) command.taskId = input.taskId;
  if (input.turnId !== undefined) command.turnId = input.turnId;
  return await dispatchWorkflowCommand(sessionCommandHookToken(input.sessionId), command);
}

function isInactiveCommandTarget(error: unknown): boolean {
  if (HookNotFoundError.is(error)) return true;
  for (const candidate of walkCauseChain(error)) {
    if (
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves hook ownership for replay-idempotent work already running inside a
 * durable step. Request handlers must return from start/resume acceptance and
 * leave ownership arbitration to the workflow.
 */
export async function waitForCommandHookOwner(token: string): Promise<WorkflowHookRecord> {
  const deadline = Date.now() + COMMAND_HOOK_READY_TIMEOUT_MS;
  while (true) {
    try {
      return normalizeWorkflowHook(await getHookByToken(token));
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function waitForCommandHookRelease(token: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + COMMAND_HOOK_READY_TIMEOUT_MS;
  while (true) {
    try {
      const owner = normalizeWorkflowHook(await getHookByToken(token));
      if (owner.runId !== sessionId) return;
    } catch (error) {
      if (HookNotFoundError.is(error)) return;
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${sessionId}" to release its command inbox.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts a workflow on the deployment executing this call. */
export async function startWorkflowOnCurrentDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  return await startWorkflowOnDeployment(
    workflow,
    args,
    process.env.VERCEL_DEPLOYMENT_ID?.trim() || undefined,
    options,
  );
}

/**
 * Starts on the deployment that accepted a delivery when one was stamped,
 * otherwise stays on the deployment executing this call.
 */
export async function startWorkflowOnAcceptedDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  acceptedDeploymentId: string | undefined,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  if (acceptedDeploymentId === undefined) {
    return await startWorkflowOnCurrentDeployment(workflow, args, options);
  }

  return await startWorkflowOnDeployment(workflow, args, acceptedDeploymentId, options);
}

async function startWorkflowOnDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  deploymentId: string | undefined,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  return await withWorkflowStartContext(async () => {
    if (deploymentId !== undefined) {
      return await start(workflow, args, { ...options, deploymentId });
    }
    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  });
}

async function withWorkflowStartContext<TResult>(callback: () => Promise<TResult>) {
  // Agent parentage is reconstructed from Eve's serialized trace context. Only
  // remove the ambient span marked by an agent boundary; the marker is not
  // propagated into Workflow runs, so Workflow-to-Workflow traces stay intact.
  const activeContext = context.active();
  const workflowContext = isAgentTraceContext(activeContext)
    ? trace.deleteSpan(activeContext)
    : activeContext;
  return await context.with(workflowContext, callback);
}

function normalizeWorkflowHook(value: unknown): WorkflowHookRecord {
  if (value === null || typeof value !== "object" || !("runId" in value)) {
    throw new Error("Workflow hook did not include a run id.");
  }

  const runId = (value as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Workflow hook did not include a run id.");
  }

  return {
    runId,
  };
}
