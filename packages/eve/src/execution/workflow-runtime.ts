import { durableRunEnded } from "#execution/hosts.js";
import { workflowEntryReference } from "#execution/workflow-references.js";
import { installWorkflowHost, workflowHost } from "#execution/workflow-host/host.js";
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
import { platformContext } from "#platform/context.js";
import { formatCapabilityError } from "#internal/capability-error.js";
import {
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
import {
  endStrandedSession,
  resolveStrandedSessionId,
} from "#execution/session-inbox/end-stranded-session.js";
import { waitForSessionHooksRelease } from "#execution/session-inbox/hook-release.js";
import {
  AcceptedSessionIdentityError,
  resolveSessionInbox,
  resumeSessionInbox,
} from "#execution/session-inbox/resume.js";
import { logicalSessionToken } from "#execution/session-inbox/address.js";
import {
  assertRunnableSessionInbox,
  assertRunnableSessionOwner,
  findSessionHookHolder,
  StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();

const log = createLogger("execution.workflow-runtime");

interface WorkflowHookRecord {
  readonly runId: string;
}

interface SessionInboxOwnerRecord extends WorkflowHookRecord {
  readonly sessionId: string;
}

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

export function createWorkflowRuntime(config: SessionRuntimeConfig): Runtime {
  installWorkflowHost();
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
      const records = readSessionRecords(sessionId, options?.startIndex);
      try {
        await assertFollowableSession(sessionId);
      } catch (error) {
        await records.cancel().catch(() => {});
        throw error;
      }
      return records;
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
    if (error instanceof StrandedSessionOwnerError) throw error;
    if (isInactiveCommandTarget(error)) return inactiveCommandResult(command);
    const logicalToken = logicalSessionToken(token);
    log.error("failed to dispatch session command", {
      command: command.kind,
      error: formatCapabilityError(error, [logicalToken, sessionInboxHookToken(logicalToken)]),
    });
    throw error;
  }

  if (command.kind === "reset") {
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

async function assertFollowableSession(sessionId: string): Promise<void> {
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

function sessionStrandedError(
  stranded: StrandedSessionOwnerError,
  nextStep?: string,
): SessionStrandedError {
  const owner = stranded.eveVersion === undefined ? {} : { eveVersion: stranded.eveVersion };
  return new SessionStrandedError(owner, describeStrandedSession(owner, nextStep));
}

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
    let failure = error;
    if (error instanceof StrandedSessionOwnerError) {
      if (options?.runnable === true) throw sessionStrandedError(error);
      try {
        return { sessionId: await resolveStrandedSessionId(error) };
      } catch (cause) {
        failure = cause;
      }
    }
    log.error("failed to resolve session by continuation token", {
      error: formatCapabilityError(failure, [continuationToken]),
    });
    throw failure;
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

export async function hasRunEnded(runId: string): Promise<boolean> {
  return await durableRunEnded(workflowHost, runId);
}

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

type StartClaim = (runId: string) => { readonly token: string; readonly metadata?: unknown };

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
    platformContext().deployment.deploymentId() ?? (await (await getWorld()).getDeploymentId());
  if (deploymentId.length === 0 || deploymentId === "latest") {
    throw new Error("Workflow runtime could not resolve an exact deployment id.");
  }
  return deploymentId;
}

async function withWorkflowStartContext<TResult>(callback: () => Promise<TResult>) {
  const activeContext = context.active();
  const workflowContext = isAgentTraceContext(activeContext)
    ? trace.deleteSpan(activeContext)
    : activeContext;
  return await context.with(workflowContext, callback);
}
