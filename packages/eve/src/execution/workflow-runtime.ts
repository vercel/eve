import { prewarmWorkflowSession } from "#execution/session-prewarm.js";
import { validateToolStubTargets } from "#tool-stubs/validate-targets.js";
import { validateDeliveryIdempotencyKey } from "#channel/delivery-idempotency.js";
import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type {
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
  EVE_PREWARM_ATTRIBUTE,
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
import type { MessageStreamEvent, SessionPredecessor } from "#protocol/message.js";
import { SessionPredecessorKey } from "#context/keys.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { walkCauseChain } from "#shared/errors.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { isAgentTraceContext } from "#tracing/eve/agent-trace-context.js";
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
  findSessionHookHolder,
  StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { initializeSessionInstrumentation } from "#instrumentation/runtime.js";
import {
  SESSION_TIMEOUT_WORKFLOW_NAME,
  WORKFLOW_TOOL_RUN_WORKFLOW_NAME,
  WORKFLOW_ENTRY_NAME,
  CONNECTION_EVENT_WORKFLOW_NAME,
  CONNECTION_EVENT_DELIVERY_WORKFLOW_NAME,
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

export const connectionEventWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${CONNECTION_EVENT_WORKFLOW_NAME}`,
};

export const connectionEventDeliveryWorkflowReference = {
  workflowId: `workflow//${STABLE_ID_BASE}//${CONNECTION_EVENT_DELIVERY_WORKFLOW_NAME}`,
};

/**
 * Creates a workflow-backed runtime whose current owner executes turns and
 * whose original run retains the public event stream across owner handoffs.
 */
export function createWorkflowRuntime(config: {
  readonly agentSessionRuntimeOverrides?: AgentSessionRuntimeOverrides;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}): Runtime {
  /** `predecessor` is set only on a successor of a retired session that has just ended. */
  const startSession = async (
    input: RunInput,
    predecessor?: SessionPredecessor,
  ): Promise<RunHandle> => {
    validateDeliveryIdempotencyKey(input.idempotencyKey);
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: config.compiledArtifactsSource,
      nodeId: config.nodeId,
    });
    if (input.toolStubs !== undefined && input.toolStubs.rootSessionId === undefined) {
      validateToolStubTargets(input.toolStubs.rules, bundle.graph);
    }
    const ctx = buildRunContext({
      agentSessionRuntimeOverrides: config.agentSessionRuntimeOverrides,
      bundle,
      dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
      run: input,
    });
    if (predecessor !== undefined) ctx.set(SessionPredecessorKey, predecessor);
    const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
    const traceDecision = initializeSessionInstrumentation({
      agentName: effectiveAgent.turnAgent.id,
      ctx,
    });
    const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
    // Workflow cannot purge inputs and outputs independently.
    const retention =
      bundle.resolvedAgent.config?.experimental?.workflow?.retention ??
      (traceDecision.action === "record" &&
      traceDecision.recordInputs &&
      traceDecision.recordOutputs
        ? undefined
        : 0);
    const serializedContext = serializeContext(ctx);
    const parentLineage = readParentLineage(serializedContext);
    const workflowInput: {
      -readonly [K in keyof InitialWorkflowEntryInput]: InitialWorkflowEntryInput[K];
    } = {
      idempotencyKey: input.idempotencyKey,
      kind: "initial",
      input: input.input,
      ownerDeploymentId: await resolveCurrentWorkflowDeploymentId(),
      serializedContext,
    };
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
      [EVE_PREWARM_ATTRIBUTE]: "1",
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

    let sessionId = run.runId;
    if (input.idempotencyKey !== undefined && input.continuationToken !== undefined) {
      // Keyed contenders must return the winning session, not their discarded candidate.
      const owner = await pollUntil(
        () => resolveContinuation(input.continuationToken!),
        SESSION_HOOK_HANDOVER_TIMEOUT_MS,
      );
      if (owner === undefined) {
        throw new Error(
          "Delivery accepted, but its session identity is not ready. Retry with the same idempotencyKey.",
        );
      }
      sessionId = owner.sessionId;
    }
    let events: ReadableStream<MessageStreamEvent> | undefined;
    const getEvents = () => {
      events ??= readSessionEventStream(sessionId);
      return events;
    };

    return {
      get events() {
        return getEvents();
      },
      sessionId,
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
        const previousSessionId = await endStrandedSession(error, continuationToken, "message");
        const started = await startSession(successor, { sessionId: previousSessionId });
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
      // Recorded history needs no owner, so reading it never inspects the session's lifecycle.
      if (options?.follow === false) return readSessionEventHistory(sessionId, options.startIndex);
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

    resolveContinuation,
  };
}

async function dispatchWorkflowCommand<TCommand extends SessionCommand>(
  token: string | SessionInboxAddress,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  if (command.kind === "prewarm") {
    return (
      typeof token === "string"
        ? { status: "unsupported" }
        : await prewarmWorkflowSession(token.sessionId, command.targetDeploymentId)
    ) as SessionCommandResult<TCommand>;
  }
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
      { ownerRunId: hook.runId, sessionId: hook.sessionId },
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

/** The session holding a continuation token's inbox, if any does. */
export async function resolveContinuation(
  continuationToken: string,
  options?: { readonly runnable?: boolean },
): Promise<{ sessionId: string } | undefined> {
  let owner: { sessionId: string };
  try {
    owner = await resolveSessionInbox(continuationToken);
  } catch (error) {
    if (HookNotFoundError.is(error)) {
      return undefined;
    }
    logError(log, "failed to resolve session by continuation token", error, {
      continuationToken,
    });
    throw error;
  }
  if (options?.runnable !== true) return owner;
  try {
    await assertRunnableSessionInbox(
      sessionInboxHookToken(sessionCommandHookToken(owner.sessionId)),
    );
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) throw sessionStrandedError(error);
    throw error;
  }
  return owner;
}

/**
 * Resolves hook ownership for replay-idempotent work already running inside a
 * durable step. Request handlers must return from start/resume acceptance and
 * leave ownership arbitration to the workflow.
 */
export async function waitForCommandHookOwner(token: string): Promise<WorkflowHookRecord> {
  const owner = await pollUntil(async () => {
    try {
      return normalizeWorkflowHook(await getHookByToken(token));
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      return undefined;
    }
  }, SESSION_HOOK_HANDOVER_TIMEOUT_MS);
  if (owner === undefined) throw new HookNotFoundError(token);
  return owner;
}

/**
 * Waits until a started session claims its inbox, which it does when its run
 * first suspends. Resolves `false` when the run ended without an inbox, so
 * there is nothing left to command.
 */
export async function waitForSessionInbox(sessionId: string): Promise<boolean> {
  const token = sessionInboxHookToken(sessionCommandHookToken(sessionId));
  const opened = await pollUntil(async () => {
    if ((await findSessionHookHolder(token)) !== undefined) return true;
    return (await hasRunEnded(sessionId)) ? false : undefined;
  }, SESSION_HOOK_HANDOVER_TIMEOUT_MS);
  if (opened === undefined) {
    throw new Error(
      `Session "${sessionId}" did not start taking commands within ${SESSION_HOOK_HANDOVER_TIMEOUT_MS / 1000} seconds.`,
    );
  }
  return opened;
}

/**
 * Calls `check` until it returns a value, backing off from 20 ms to 200 ms
 * between calls, and resolves `undefined` once `timeoutMs` passes without one.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (let delayMs = 20; ; delayMs = Math.min(delayMs * 2, 200)) {
    const value = await check();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

/** A run `start()` accepted may not be readable yet, which is not an ended run. */
export async function hasRunEnded(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status !== "pending" && status !== "running";
  } catch (error) {
    for (const cause of walkCauseChain(error)) {
      if (WorkflowRunNotFoundError.is(cause)) return false;
    }
    if (isInactiveCommandTarget(error)) return true;
    throw error;
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
export async function startWorkflowOnDeployment<TArgs extends unknown[], TResult>(
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
