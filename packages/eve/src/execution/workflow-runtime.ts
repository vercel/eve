import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

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
import { serializeContext } from "#context/serialize.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  getHookByToken,
  getRun,
  resumeHook,
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
import { RuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import type { WorkflowEntryInput } from "#execution/workflow-entry.js";
import { walkCauseChain } from "#shared/errors.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

const WORKFLOW_ENTRY_NAME = "workflowEntry";
const TURN_WORKFLOW_NAME = "turnWorkflow";
const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
const TASK_RUN_WORKFLOW_NAME = "taskRunWorkflow";
const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const COMMAND_HOOK_READY_TIMEOUT_MS = 30_000;

export const LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE =
  "deploymentId 'latest' requires a World that implements resolveLatestDeploymentId()";

/**
 * Workflow function names whose bundled id is stable across deployments
 * (no `@<pkg.version>` stamp). The bundler reads this set when emitting
 * the workflow id so cross-deployment routing — `start(ref, args, {
 * deploymentId: "latest" })` — finds the same workflow on a newer
 * deployment even when the eve version differs.
 *
 * Both halves of the contract (bundler output and runtime reference
 * template) read this single set so they cannot drift.
 */
export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  TASK_RUN_WORKFLOW_NAME,
]);

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
 * child workflow runs. The id omits the package version stamp so
 * `start(turnWorkflowReference, args, { deploymentId: "latest" })`
 * routes to the latest deployment's turn workflow even when the eve
 * version differs from the caller's deployment.
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
      const serializedContext = serializeContext(ctx);
      const parentLineage = readParentLineage(serializedContext);
      const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
      const workflowInput: {
        -readonly [K in keyof WorkflowEntryInput]: WorkflowEntryInput[K];
      } = {
        input: input.input,
        limits: input.limits,
        serializedContext,
      };
      if (sessionTimeoutMs !== undefined) {
        workflowInput.sessionTimeoutMs = sessionTimeoutMs;
      }

      const attributes =
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

      let run: Awaited<ReturnType<typeof startWorkflowPreferLatest>>;
      try {
        run = await startWorkflowPreferLatest(workflowEntryReference, [workflowInput], {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(attributes),
        });
      } catch (error) {
        logError(log, "failed to start workflow run", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }

      if (input.continuationToken) {
        const owner = await waitForCommandHookOwner(input.continuationToken);
        if (owner.runId !== run.runId) {
          throw new RuntimeSessionOwnershipConflictError({
            continuationToken: input.continuationToken,
            ownerSessionId: owner.runId,
            sessionId: run.runId,
          });
        }
      }
      await waitForOwnedCommandHook(sessionCommandHookToken(run.runId), run.runId);

      let events: ReadableStream<MessageStreamEvent> | undefined;
      const getEvents = () => {
        events ??= parseNdjsonStream<MessageStreamEvent>(() => getRun(run.runId).getReadable());
        return events;
      };

      return {
        continuationToken: input.continuationToken ?? run.runId,
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

async function dispatchWorkflowCommand<TCommand extends SessionCommand>(
  token: string,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  let hook: WorkflowHookRecord;
  try {
    hook = normalizeWorkflowHook(await resumeHook(token, command));
  } catch (error) {
    if (isInactiveCommandTarget(error)) {
      return inactiveCommandResult(command, error);
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
        ? { status: "accepted" as const }
        : { sessionId, status: "accepted" as const };
  return result as SessionCommandResult<TCommand>;
}

function inactiveCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  error: unknown,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "send"
      ? { status: "session_not_active" as const }
      : command.kind === "cancel"
        ? { reason: classifyInactiveCancelTarget(error), status: "no_active_turn" as const }
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

function classifyInactiveCancelTarget(error: unknown): string | undefined {
  if (HookNotFoundError.is(error)) return "HookNotFoundError";
  if (WorkflowRunNotFoundError.is(error)) return "WorkflowRunNotFoundError";
  if (RunExpiredError.is(error)) return "RunExpiredError";
  if (EntityConflictError.is(error)) return "EntityConflictError";
  return undefined;
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

async function waitForOwnedCommandHook(token: string, sessionId: string): Promise<void> {
  const owner = await waitForCommandHookOwner(token);
  if (owner.runId !== sessionId) {
    throw new RuntimeSessionOwnershipConflictError({
      continuationToken: token,
      ownerSessionId: owner.runId,
      sessionId,
    });
  }
}

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

/**
 * Starts a workflow on the latest deployment when latest routing applies,
 * while preserving local/dev worlds that do not implement latest routing.
 */
export async function startWorkflowPreferLatest<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  if (!shouldRouteToLatestDeployment()) {
    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  }

  try {
    return await start(workflow, args, { ...options, deploymentId: "latest" });
  } catch (error) {
    if (!isLatestDeploymentUnsupportedError(error)) {
      throw error;
    }

    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  }
}

/**
 * Local development resolves "latest" to the active promoted generation.
 * Vercel resolves it only for production deployments; previews and CLI
 * deployments have no branch reference and remain pinned to themselves.
 */
function shouldRouteToLatestDeployment(): boolean {
  return process.env.VERCEL_ENV === "production" || isEveDevEnvironment();
}

function isLatestDeploymentUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE);
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
