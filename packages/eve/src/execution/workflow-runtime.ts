import { prewarmWorkflowSession } from "#execution/session-prewarm.js";
import { readRemoteChildBinding } from "#execution/child-binding.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  EntityConflictError,
  HookConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  SessionStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  EVE_VERSION_ATTRIBUTE,
  EVE_PREWARM_ATTRIBUTE,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import { formatCapabilityError } from "#internal/capability-error.js";
import {
  getRun,
  getWorld,
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";
import { assertStartClaims, pinRunId } from "#internal/workflow/start-claim.js";
import type { SessionPredecessor } from "#protocol/session-events/families/session.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import {
  assertSessionHistoryReadable,
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { prepareInitialEntry, type SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import { walkCauseChain } from "#shared/errors.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { isAgentTraceContext } from "#tracing/eve/agent-trace-context.js";
import {
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionCommandHookToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { endStrandedSession } from "#execution/session-inbox/end-stranded-session.js";
import { waitForSessionHooksRelease } from "#execution/session-inbox/hook-release.js";
import {
  AcceptedSessionIdentityError,
  resolveSessionInbox,
  logicalSessionToken,
  resumeSessionInbox,
} from "#execution/session-inbox/resume.js";
import {
  assertRunnableSessionInbox,
  assertRunnableSessionOwner,
  findSessionHookHolder,
  StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
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

/** Starts tried while each one finds an owner that ends before taking the delivery. */
const CONTINUATION_START_ATTEMPTS = 3;

function sessionHandle(
  sessionId: string,
  deliveryId: string | undefined,
  claimedContinuation?: boolean,
): RunHandle {
  let events: ReadableStream<SessionStreamEvent> | undefined;
  return {
    get events() {
      events ??= readSessionEventStream(sessionId);
      return events;
    },
    sessionId,
    ...(deliveryId !== undefined && { deliveryId }),
    ...(claimedContinuation !== undefined && { claimedContinuation }),
  };
}

/**
 * Creates a workflow-backed runtime whose current owner executes turns and
 * whose original run retains the public event stream across owner handoffs.
 */
export function createWorkflowRuntime(config: SessionRuntimeConfig): Runtime {
  /** `predecessor` is set only on a successor of a retired session that has just ended. */
  const startSession = async (
    input: RunInput,
    predecessor?: SessionPredecessor,
    attempt = 0,
  ): Promise<RunHandle> => {
    const prepared = await prepareInitialEntry(config, input, predecessor);
    input = prepared.input;
    const { agent, serializedContext } = prepared;
    const retention = prepared.entry.retention;
    const parentLineage = readParentLineage(serializedContext);
    const workflowInputBase: InitialWorkflowEntryInput = {
      ...prepared.entry,
      ownerDeploymentId: await resolveCurrentWorkflowDeploymentId(),
    };
    const sessionAttributes =
      parentLineage.sessionId === undefined
        ? buildSessionAttributes({
            serializedContext,
          })
        : buildSubagentRootAttributes({
            identity: { nodeId: runtimeNodeId(agent) },
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

    const { continuationToken } = input;
    // The run claims one address as it is admitted. A continuation address
    // tells the caller at once whether this run or an earlier one owns it.
    // Without one, the session's own inbox takes commands before the run boots.
    assertStartClaims(await getWorld());
    const hasContinuation = continuationToken !== undefined && continuationToken !== "";
    const workflowInput: InitialWorkflowEntryInput = {
      ...workflowInputBase,
      startClaim: hasContinuation ? "continuation" : "inbox",
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
        (runId) => ({
          token: sessionInboxHookToken(
            hasContinuation ? continuationToken : sessionCommandHookToken(runId),
          ),
          metadata: { [SESSION_INBOX_SESSION_ID_METADATA_KEY]: runId },
        }),
      );
    } catch (error) {
      if (hasContinuation && HookConflictError.is(error)) {
        return await joinContinuationOwner(input, predecessor, attempt);
      }
      log.error("failed to start workflow run", {
        error: formatCapabilityError(error, [input.continuationToken]),
      });
      throw error;
    }

    return sessionHandle(run.runId, input.delivery?.deliveryId, hasContinuation ? true : undefined);
  };

  /**
   * Another session already owned the address this start claimed, and no run
   * was created. A send goes to that owner as the delivery the caller meant;
   * any other start was a duplicate and names the owner. An owner that ended
   * since leaves the address free, so the start is tried again.
   */
  const joinContinuationOwner = async (
    input: RunInput,
    predecessor: SessionPredecessor | undefined,
    attempt: number,
  ): Promise<RunHandle> => {
    const continuationToken = input.continuationToken!;
    const command = input.continuationConflictCommand;
    let owner: string | undefined;
    if (command === undefined) {
      owner = (await resolveContinuation(continuationToken))?.sessionId;
    } else {
      const result = await dispatchContinuation({ command, continuationToken, successor: input });
      if (result.status === "accepted") owner = result.sessionId;
    }
    if (owner !== undefined) return sessionHandle(owner, input.delivery?.deliveryId, false);
    if (attempt + 1 >= CONTINUATION_START_ATTEMPTS)
      throw new SessionNotActiveError({ retryable: true });
    return await startSession(input, predecessor, attempt + 1);
  };

  const dispatchContinuation = async <TCommand extends SessionCommand>(
    input: DispatchContinuationInput<TCommand>,
  ): Promise<SessionCommandResult<TCommand>> => {
    const { continuationToken, successor } = input;
    const command = identifyCommand(input.command);
    try {
      return await dispatchWorkflowCommand(continuationToken, command);
    } catch (error) {
      if (!(error instanceof StrandedSessionOwnerError)) throw error;
      if (command.kind !== "send" || successor === undefined) {
        return await settleStrandedCommand(continuationToken, command, error);
      }
      // A successor has no request for these answers, so they cannot be delivered anywhere.
      if ((command.payload.answers?.length ?? 0) > 0) {
        throw sessionStrandedError(
          error,
          "Its pending requests can no longer be answered; send a new message to start a fresh session.",
        );
      }
      const previousSessionId = await endStrandedSession(error, continuationToken, "message");
      const started = await startSession(
        { ...successor, delivery: command.delivery },
        { sessionId: previousSessionId },
      );
      return {
        sessionId: started.sessionId,
        deliveryId: command.delivery?.deliveryId,
        status: "accepted",
      } as SessionCommandResult<TCommand>;
    }
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      return await startSession(input);
    },

    dispatchContinuation,

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowSessionCommand(input);
    },

    async getEventStream(
      sessionId: string,
      options?: SessionStreamOptions,
    ): Promise<ReadableStream<SessionStreamEvent>> {
      // Recorded history needs no owner, so reading it never inspects the session's lifecycle.
      if (options?.follow === false)
        return readSessionEventHistory(sessionId, options.startIndex, options.signal);
      await assertFollowableSession(sessionId);
      return readSessionEventStream(sessionId, options?.startIndex, options?.signal);
    },

    async getLineStream(
      sessionId: string,
      options?: SessionStreamOptions,
    ): Promise<ReadableStream<unknown>> {
      if (options?.follow === false) return readSessionRecordHistory(sessionId, options.startIndex);
      await assertFollowableSession(sessionId);
      return readSessionRecords(sessionId, options?.startIndex);
    },

    async getStreamTailIndex(sessionId: string): Promise<number> {
      return await readSessionStreamTailIndex(sessionId);
    },

    async readChildBinding(sessionId: string, childSessionId: string) {
      return await readRemoteChildBinding(sessionId, childSessionId);
    },

    async hasRunnableOwner(sessionId: string): Promise<boolean> {
      const token = sessionInboxHookToken(sessionCommandHookToken(sessionId));
      const holder = await findSessionHookHolder(token);
      if (holder === undefined) return false;
      try {
        await assertRunnableSessionOwner(holder);
        return true;
      } catch (error) {
        if (error instanceof StrandedSessionOwnerError) return false;
        throw error;
      }
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
  let inbox: string | undefined;
  let startAddress: string | undefined;
  try {
    const resumed = await resumeSessionInbox(token, command);
    inbox = resumed.inbox;
    startAddress = resumed.startAddress;
    hook = { runId: resumed.ownerRunId, sessionId: await resumed.sessionId };
  } catch (error) {
    // Each entry point decides what a stranded owner means for its caller.
    if (error instanceof StrandedSessionOwnerError) throw error;
    // A session's start claims its address, so a missing hook means it ended.
    if (isInactiveCommandTarget(error)) return inactiveCommandResult(command);
    const logicalToken = logicalSessionToken(token);
    log.error("failed to dispatch session command", {
      command: command.kind,
      error: formatCapabilityError(error, [logicalToken, sessionInboxHookToken(logicalToken)]),
    });
    throw error;
  }

  if (command.kind === "reset") {
    // A session that took the reset before booting holds only its start address yet.
    await waitForSessionHooksRelease(
      [
        sessionCommandHookToken(hook.sessionId),
        logicalSessionToken(token),
        ...(startAddress === undefined ? [] : [startAddress]),
      ],
      { ownerRunId: hook.runId, sessionId: hook.sessionId },
    );
  }

  const result = activeCommandResult(command, hook.sessionId);
  return (
    result.status === "accepted" ? { ...result, inbox } : result
  ) as SessionCommandResult<TCommand>;
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
      const previousSessionId = await endStrandedSession(stranded, address, "reset", command);
      return { previousSessionId, status: "reset" } as SessionCommandResult<TCommand>;
    }
    case "send":
    case "clear":
      throw sessionStrandedError(stranded);
    default:
      return inactiveCommandResult(command);
  }
}

/**
 * An ended session has no inbox, and a dormant `eve dev` run may resume; either recorded stream
 * stays readable. Only a stranded owner refuses a follow.
 */
async function assertFollowableSession(sessionId: string): Promise<void> {
  // An ended session has no inbox, and a dormant `eve dev` run may resume; either recorded
  // stream stays readable. Only a stranded owner, an unknown session, or expired history refuses.
  try {
    await Promise.all([
      assertRunnableSessionInbox(sessionInboxHookToken(sessionCommandHookToken(sessionId))),
      assertSessionHistoryReadable(sessionId),
    ]);
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) throw sessionStrandedError(error);
    throw error;
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

/**
 * Sends one command to a session through its stable command inbox. A caller
 * holding the session id asked for that exact session, so a send to a
 * stranded one is refused rather than replaced.
 */
export async function dispatchWorkflowSessionCommand<TCommand extends SessionCommand>(
  input: DispatchSessionInput<TCommand>,
): Promise<SessionCommandResult<TCommand>> {
  const address = { sessionId: input.sessionId, inbox: input.inbox };
  const command = identifyCommand(input.command);
  try {
    return await dispatchWorkflowCommand(address, command);
  } catch (error) {
    if (!(error instanceof StrandedSessionOwnerError)) throw error;
    return await settleStrandedCommand(address, command, error);
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
    log.error("failed to resolve session by continuation token", {
      error: formatCapabilityError(error, [continuationToken]),
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
 * The hook the run holds from its admission, given the id of the run the
 * start creates. A run that already holds the token refuses the start with
 * `HookConflictError` naming that run, and no run is created. Requires a
 * World that passes {@link assertStartClaims}.
 */
type StartClaim = (runId: string) => { readonly token: string; readonly metadata?: unknown };

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
  claim?: StartClaim,
): Promise<Run<unknown> | Run<TResult>> {
  return await withWorkflowStartContext(async () => {
    if (deploymentId.length === 0 || deploymentId === "latest") {
      throw new Error("Workflow starts require an exact deployment id.");
    }
    const startOptions = {
      ...options,
      allowReservedAttributes: true,
      attributes: { ...options?.attributes, [EVE_VERSION_ATTRIBUTE]: EVE_PACKAGE_INFO.version },
      deploymentId,
    };
    if (claim === undefined) return await start(workflow, args, startOptions);
    const pinned = pinRunId(await getWorld(), startOptions);
    const run = await start(workflow, args, {
      ...startOptions,
      experimental_hook: claim(pinned.runId),
      world: pinned.world,
    });
    if (run.runId !== pinned.runId) {
      // The hook's metadata names a run that does not exist; nothing may use it.
      await run.cancel().catch(() => {});
      throw new Error(
        `Workflow started run "${run.runId}" instead of the pinned "${pinned.runId}", so its claimed hook names the wrong run.`,
      );
    }
    return run;
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

