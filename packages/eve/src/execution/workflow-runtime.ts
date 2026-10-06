import { validateToolStubTargets } from "#tool-stubs/validate-targets.js";
import { context, trace } from "#compiled/@opentelemetry/api/index.js";
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
  EVE_VERSION_ATTRIBUTE,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import {
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
import {
  readSessionEventStream,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import {
  SESSION_HANDOFF_VERSION,
  type HandoffWorkflowEntryInput,
  type InitialWorkflowEntryInput,
  type SessionHandoffStart,
} from "#execution/session/entry-input.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
import { walkCauseChain } from "#shared/errors.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { isAgentTraceContext } from "#tracing/agent-trace-context.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import { endStrandedSession } from "#execution/session-inbox/end-stranded-session.js";
import {
  SESSION_HOOK_HANDOVER_TIMEOUT_MS,
  waitForSessionHooksRelease,
} from "#execution/session-inbox/hook-release.js";
import {
  AcceptedSessionIdentityError,
  resolveSessionInbox,
  logicalSessionToken,
  resumeSessionInbox,
  SessionHandoffPendingError,
} from "#execution/session-inbox/resume.js";
import {
  assertRunnableSessionInbox,
  StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { initializeSessionInstrumentation } from "#instrumentation/runtime.js";
import {
  SESSION_TIMEOUT_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
} from "#execution/stable-workflow-names.js";
const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();

const STABLE_ID_BASE = EVE_PACKAGE_INFO.name;

const log = createLogger("execution.workflow-runtime");

interface WorkflowHookRecord {
  readonly runId: string;
}

interface SessionInboxOwnerRecord extends WorkflowHookRecord {
  readonly sessionId: string;
}

/**
 * Stable workflow reference used by `start()` to locate the workflow
 * entrypoint registered by the Workflow DevKit builder. The id omits
 * the package version stamp so the long-lived owner can rotate across
 * deployments without rewriting the registry key.
 */
export const workflowEntryReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_ENTRY_NAME}`,
};

/** Stable workflow reference for session deadline timers. */
export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

/** Stable workflow reference for authored workflow tool runs. */
export const workflowToolRunWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${WORKFLOW_TOOL_RUN_WORKFLOW_NAME}`,
};

/**
 * Creates a workflow-backed runtime whose current owner executes turns and
 * whose original run retains the public event stream across owner handoffs.
 */
export function createWorkflowRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}): Runtime {
  const startSession = async (input: RunInput): Promise<RunHandle> => {
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: config.compiledArtifactsSource,
      nodeId: config.nodeId,
    });
    if (input.toolStubs !== undefined && input.toolStubs.rootSessionId === undefined) {
      validateToolStubTargets(input.toolStubs.rules, bundle.graph);
    }
    const ctx = buildRunContext({
      bundle,
      dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
      run: input,
    });
    const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
    initializeSessionInstrumentation({
      agentName: effectiveAgent.turnAgent.id,
      ctx,
    });
    const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
    // Retention is always the authored value: `experimental` cannot be
    // selected by a dynamic subagent config, so there is nothing to resolve.
    const retention = bundle.resolvedAgent.config?.experimental?.workflow?.retention;
    const serializedContext = serializeContext(ctx);
    const parentLineage = readParentLineage(serializedContext);
    const workflowInput: {
      -readonly [K in keyof InitialWorkflowEntryInput]: InitialWorkflowEntryInput[K];
    } = {
      kind: "initial",
      input: input.input,
      ownerDeploymentId: await resolveCurrentWorkflowDeploymentId(),
      serializedContext,
    };
    if (input.limits !== undefined) workflowInput.limits = input.limits;
    if (input.continuationConflictCommand !== undefined) {
      workflowInput.continuationConflictCommand = input.continuationConflictCommand;
    }
    if (sessionTimeoutMs !== undefined) {
      workflowInput.sessionTimeoutMs = sessionTimeoutMs;
    }
    if (retention !== undefined) {
      workflowInput.retention = retention;
    }
    const sessionAttributes =
      parentLineage.sessionId === undefined
        ? buildSessionAttributes({
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
      const startOptions: StartOptionsWithoutDeploymentId = {
        allowReservedAttributes: true,
        attributes: normalizeEveAttributes(attributes),
      };
      if (retention !== undefined) startOptions.experimental_retention = retention;
      run = await startWorkflowOnDeployment(
        workflowEntryReference,
        [workflowInput],
        workflowInput.ownerDeploymentId,
        startOptions,
      );
    } catch (error) {
      logError(log, "failed to start workflow run", error, {
        continuationToken: input.continuationToken,
      });
      throw error;
    }

    let events: ReadableStream<MessageStreamEvent> | undefined;
    const getEvents = () => {
      events ??= readSessionEventStream(run.runId);
      return events;
    };

    return {
      get events() {
        return getEvents();
      },
      sessionId: run.runId,
    };
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      return await startSession(input);
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      const { command, continuationToken, successor } = input;
      try {
        return await dispatchWorkflowCommand(continuationToken, command);
      } catch (error) {
        if (!(error instanceof StrandedSessionOwnerError)) throw error;
        if (command.kind !== "send" || successor === undefined) {
          return await settleStrandedCommand(continuationToken, command, error);
        }
        // A successor has no request for these answers, so they cannot be delivered anywhere.
        if ((command.payload.inputResponses?.length ?? 0) > 0) {
          throw sessionStrandedError(
            error,
            "Its pending requests can no longer be answered; send a new message to start a fresh session.",
          );
        }
        await endStrandedSession(error, continuationToken, "message");
        const started = await startSession(successor);
        return {
          sessionId: started.sessionId,
          status: "accepted",
        } as SessionCommandResult<TCommand>;
      }
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowSessionCommand(input);
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<MessageStreamEvent>> {
      // An ended session has no inbox, and a dormant `eve dev` run may resume;
      // either recorded stream stays readable. Only a stranded owner refuses.
      try {
        await assertRunnableSessionInbox(sessionInboxHookToken(sessionCommandHookToken(sessionId)));
      } catch (error) {
        if (error instanceof StrandedSessionOwnerError) throw sessionStrandedError(error);
        throw error;
      }
      return readSessionEventStream(sessionId, options?.startIndex);
    },

    async getStreamTailIndex(sessionId: string): Promise<number> {
      return await readSessionStreamTailIndex(sessionId);
    },

    async resolveContinuation(
      continuationToken: string,
    ): Promise<{ sessionId: string } | undefined> {
      try {
        return await resolveSessionInbox(continuationToken);
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

export type SessionOwnerStartInput = SessionHandoffStart & {
  readonly activationToken: string;
  /** Original run whose stream stays the public session stream. */
  readonly anchorRunId: string;
  readonly checkpoint: SessionCheckpoint;
  readonly targetDeploymentId: string;
};

/** Starts a successor owner and binds its output to the original session stream. */
export async function startSessionOwnerStep(input: SessionOwnerStartInput): Promise<void> {
  "use step";
  const { activationToken, anchorRunId, checkpoint, targetDeploymentId, ...start } = input;
  const workflowInput: HandoffWorkflowEntryInput = {
    ...start,
    activationToken,
    checkpoint,
    handoffVersion: SESSION_HANDOFF_VERSION,
    kind: "handoff",
    ownerDeploymentId: targetDeploymentId,
    sessionWritable: getRun(anchorRunId).getWritable<Uint8Array>(),
    sessionId: anchorRunId,
  };
  // The successor is stamped with this eve version at start, because the
  // queue guard runs before it boots. Single-build Worlds share this version;
  // deployment-affine Worlds bypass the guard and the successor records its
  // own version at boot.
  await startWorkflowOnDeployment(
    workflowEntryReference,
    [workflowInput],
    targetDeploymentId,
    checkpoint.retention === undefined
      ? undefined
      : { experimental_retention: checkpoint.retention },
  );
}

async function dispatchWorkflowCommand<TCommand extends SessionCommand>(
  token: string | SessionInboxAddress,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  let hook: SessionInboxOwnerRecord;
  try {
    const resumed = await resumeSessionInbox(token, command);
    hook = { runId: resumed.ownerRunId, sessionId: await resumed.sessionId };
  } catch (error) {
    // Each entry point decides what a stranded owner means for its caller.
    if (error instanceof StrandedSessionOwnerError) throw error;
    // A send by session id to a session that still exists asks the caller to
    // retry rather than reporting the session gone.
    const sendBySessionId = command.kind === "send" && typeof token !== "string";
    const retryLater = { status: "session_not_active", retryable: true };
    // The address is owned, so it must never read as absent to a channel.
    if (error instanceof SessionHandoffPendingError) {
      if (sendBySessionId) return retryLater as SessionCommandResult<TCommand>;
      throw error;
    }
    if (isInactiveCommandTarget(error)) {
      if (sendBySessionId && (await isRunActive(token.sessionId))) {
        return retryLater as SessionCommandResult<TCommand>;
      }
      return inactiveCommandResult(command);
    }
    logError(log, "failed to dispatch session command", error, {
      command: command.kind,
      token,
    });
    throw error;
  }

  if (command.kind === "reset") {
    await waitForSessionHooksRelease(
      [sessionCommandHookToken(hook.sessionId), logicalSessionToken(token)],
      hook.runId,
    );
  }

  return activeCommandResult(command, hook.sessionId);
}

/**
 * What a command means for a stranded owner, which can run none. `reset` ends
 * the session. A send or `clear` needs the session to run, so it is refused
 * and the caller decides whether to reset. `cancel` and `compact` find no
 * active session.
 */
async function settleStrandedCommand<TCommand extends SessionCommand>(
  address: string | SessionInboxAddress,
  command: TCommand,
  stranded: StrandedSessionOwnerError,
): Promise<SessionCommandResult<TCommand>> {
  switch (command.kind) {
    case "reset": {
      const previousSessionId = await endStrandedSession(stranded, address, "reset");
      return { previousSessionId, status: "reset" } as SessionCommandResult<TCommand>;
    }
    case "send":
    case "clear":
      throw sessionStrandedError(stranded);
    default:
      return inactiveCommandResult(command);
  }
}

/** Public form of a stranded owner; `nextStep` replaces the default recovery instruction. */
function sessionStrandedError(
  stranded: StrandedSessionOwnerError,
  nextStep?: string,
): SessionStrandedError {
  const owner = stranded.eveVersion === undefined ? {} : { eveVersion: stranded.eveVersion };
  return new SessionStrandedError(owner, describeStrandedSession(owner, nextStep));
}

function activeCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  sessionId: string,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "reset"
      ? { previousSessionId: sessionId, status: "reset" as const }
      : command.kind === "send" && command.delivery !== undefined
        ? { sessionId, status: "accepted" as const, deliveryId: command.delivery.deliveryId }
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

/**
 * Sends one command to a session through its stable command inbox. A caller
 * holding the session id asked for that exact session, so a send to a
 * stranded one is refused rather than replaced.
 */
export async function dispatchWorkflowSessionCommand<TCommand extends SessionCommand>(
  input: DispatchSessionInput<TCommand>,
): Promise<SessionCommandResult<TCommand>> {
  const address = { sessionId: input.sessionId };
  try {
    return await dispatchWorkflowCommand(address, input.command);
  } catch (error) {
    if (!(error instanceof StrandedSessionOwnerError)) throw error;
    return await settleStrandedCommand(address, input.command, error);
  }
}

/** Requests cancellation through a session's stable command inbox. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  const command: { kind: "cancel"; turnId?: string } = { kind: "cancel" };
  if (input.turnId !== undefined) command.turnId = input.turnId;
  return await dispatchWorkflowSessionCommand({ command, sessionId: input.sessionId });
}

async function isRunActive(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "pending" || status === "running";
  } catch (error) {
    if (isInactiveCommandTarget(error)) return false;
    throw error;
  }
}

function isInactiveCommandTarget(error: unknown): boolean {
  if (error instanceof AcceptedSessionIdentityError) return false;
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
  const deadline = Date.now() + SESSION_HOOK_HANDOVER_TIMEOUT_MS;
  while (true) {
    try {
      return normalizeWorkflowHook(await getHookByToken(token));
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
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
    await resolveCurrentWorkflowDeploymentId(),
    options,
  );
}

/**
 * Starts a run on an exact deployment. Every run eve starts records the eve
 * version that started it: ingress and the stranded replay guard read it to
 * decide whether this build can still execute the run.
 */
async function startWorkflowOnDeployment<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  deploymentId: string,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  return await withWorkflowStartContext(async () => {
    if (deploymentId.length === 0 || deploymentId === "latest") {
      throw new Error("Workflow starts require an exact deployment id.");
    }
    return await start(workflow, args, {
      ...options,
      allowReservedAttributes: true,
      attributes: { ...options?.attributes, [EVE_VERSION_ATTRIBUTE]: EVE_PACKAGE_INFO.version },
      deploymentId,
    });
  });
}

async function resolveCurrentWorkflowDeploymentId(): Promise<string> {
  const deploymentId =
    process.env.VERCEL_DEPLOYMENT_ID?.trim() || (await (await getWorld()).getDeploymentId());
  if (deploymentId.length === 0 || deploymentId === "latest") {
    throw new Error("Workflow runtime could not resolve an exact deployment id.");
  }
  return deploymentId;
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
