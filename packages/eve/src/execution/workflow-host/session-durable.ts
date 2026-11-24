import { builtInHosts } from "#runtime/app.js";
import {
  EntityConflictError,
  HookConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import type { DeliverHookPayload, SessionCommand } from "#channel/types.js";
import { readRemoteChildBinding } from "#execution/child-binding.js";
import {
  decodeDeliveryAddress,
  reveal,
  type DeliveryResult,
  type Durable,
  type SessionStartInput,
  type SessionStartResult,
} from "#execution/durable.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  EVE_PREWARM_ATTRIBUTE,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import {
  endStrandedSession,
  resolveStrandedSessionId,
} from "#execution/session-inbox/end-stranded-session.js";
import { waitForSessionHooksRelease } from "#execution/session-inbox/hook-release.js";
import {
  logicalSessionToken,
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionCommandHookToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import {
  assertRunnableSessionInbox,
  assertRunnableSessionOwner,
  findSessionHookHolder,
  resumeSignInCallback,
  StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import {
  AcceptedSessionIdentityError,
  resolveSessionInbox,
  resumeSessionInbox,
} from "#execution/session-inbox/resume.js";
import { assertSessionHistoryReadable } from "#execution/session-event-stream.js";
import { prewarmWorkflowSession } from "#execution/session-prewarm.js";
import { sessionStrandedError, type SessionStartBody } from "#execution/session-runtime.js";
import { workflowEntryReference } from "#execution/workflow-references.js";
import {
  resolveCurrentWorkflowDeploymentId,
  startWorkflowOnDeployment,
} from "#execution/workflow-runtime.js";
import { formatCapabilityError } from "#internal/capability-error.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { createLogger } from "#internal/logging.js";
import {
  getWorld,
  resumeHook,
  type StartOptionsWithoutDeploymentId,
} from "#internal/workflow/runtime.js";
import { assertStartClaims, createRunId } from "#internal/workflow/start-claim.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { walkCauseChain } from "#shared/errors.js";

const log = createLogger("execution.workflow-runtime");

export async function startWorkflowSession(
  session: SessionStartInput,
): Promise<SessionStartResult> {
  const { entry, externalInvocation, nodeId } = reveal<SessionStartBody>(session.body);
  const { serializedContext } = entry;
  const parentLineage = readParentLineage(serializedContext);
  const ownerDeploymentId = await resolveCurrentWorkflowDeploymentId();
  const sessionAttributes =
    parentLineage.sessionId === undefined
      ? buildSessionAttributes({ serializedContext })
      : buildSubagentRootAttributes({
          identity: { nodeId },
          parentCallId: parentLineage.callId,
          parentSessionId: parentLineage.sessionId,
          parentTurnId: parentLineage.turnId,
          rootSessionId: parentLineage.rootSessionId ?? parentLineage.sessionId,
          serializedContext,
        });
  const attributes = {
    ...sessionAttributes,
    [EVE_PREWARM_ATTRIBUTE]: "1",
    ...(externalInvocation === undefined ? {} : buildInvocationAttributes(externalInvocation)),
  };
  const world = await getWorld();
  assertStartClaims(world);
  const [claimed] = session.addresses;
  const continuation =
    claimed === undefined ? undefined : continuationTokenOf(decodeDeliveryAddress(claimed));
  const input: InitialWorkflowEntryInput = {
    ...entry,
    ownerDeploymentId,
    startClaim: continuation === undefined ? "inbox" : "continuation",
  };
  const options: StartOptionsWithoutDeploymentId = {
    allowReservedAttributes: true,
    attributes: normalizeEveAttributes(attributes),
  };
  if (entry.retention !== undefined) options.experimental_retention = entry.retention;
  const sessionId =
    session.sessionId ?? createRunId(world, { ...options, deploymentId: ownerDeploymentId });
  try {
    await startWorkflowOnDeployment(
      workflowEntryReference,
      [input],
      ownerDeploymentId,
      options,
      (runId) => ({
        token: sessionInboxHookToken(continuation ?? sessionCommandHookToken(runId)),
        metadata: { [SESSION_INBOX_SESSION_ID_METADATA_KEY]: runId },
      }),
      sessionId,
    );
  } catch (error) {
    if (HookConflictError.is(error)) {
      if (session.sessionId !== undefined && (await claimHolder(continuation, sessionId)))
        return { kind: "started", sessionId };
      if (continuation !== undefined) return { kind: "held" };
    }
    log.error("failed to start workflow run", {
      error: formatCapabilityError(error, [continuation]),
    });
    throw error;
  }
  return { kind: "started", sessionId };
}

function continuationTokenOf(address: ReturnType<typeof decodeDeliveryAddress>): string {
  if (address.kind !== "session" || typeof address.address !== "string") {
    throw new Error("A Workflow session claims only a continuation address at its start.");
  }
  return address.address;
}

async function claimHolder(continuation: string | undefined, sessionId: string): Promise<boolean> {
  try {
    const owner = await resolveSessionInbox(continuation ?? sessionCommandHookToken(sessionId));
    return owner.sessionId === sessionId;
  } catch {
    return false;
  }
}

export const deliverToWorkflow: Durable["deliver"] = async (to, payload) => {
  const address = decodeDeliveryAddress(to);
  if (address.kind !== "session") {
    try {
      if (address.kind === "hook") await resumeHook(address.token, payload);
      else await resumeSignInCallback(address.token, payload as AuthorizationCallbackPayload);
    } catch (error) {
      if (isInactiveCommandTarget(error))
        return { accepted: false, reason: "inactive", cause: error };
      throw error;
    }
    return { accepted: true };
  }
  return await deliverToSession(address.address, payload as SessionCommand);
};

async function deliverToSession(
  address: string | SessionInboxAddress,
  command: SessionCommand,
): Promise<DeliveryResult> {
  let delivered: { readonly inbox?: string; readonly sessionId: string; readonly runId: string };
  let startAddress: string | undefined;
  try {
    const resumed = await resumeSessionInbox(address, command);
    startAddress = resumed.startAddress;
    delivered = {
      inbox: resumed.inbox,
      runId: resumed.ownerRunId,
      sessionId: await resumed.sessionId,
    };
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) {
      return {
        accepted: false,
        reason: "stranded",
        cause: error,
        ...(error.eveVersion !== undefined && { eveVersion: error.eveVersion }),
        end: () =>
          command.kind === "reset"
            ? endStrandedSession(error, address, "reset", command)
            : endStrandedSession(error, address, "message"),
      };
    }
    if (isInactiveCommandTarget(error))
      return { accepted: false, reason: "inactive", cause: error };
    const logicalToken = logicalSessionToken(address);
    log.error("failed to dispatch session command", {
      command: command.kind,
      error: formatCapabilityError(error, [logicalToken, sessionInboxHookToken(logicalToken)]),
    });
    throw error;
  }
  if (command.kind === "reset") {
    await waitForSessionHooksRelease(
      [
        sessionCommandHookToken(delivered.sessionId),
        logicalSessionToken(address),
        ...(startAddress === undefined ? [] : [startAddress]),
      ],
      { ownerRunId: delivered.runId, sessionId: delivered.sessionId },
    );
  }
  return { accepted: true, inbox: delivered.inbox, sessionId: delivered.sessionId };
}

export const resumeWorkflowAddress: (
  to: Parameters<Durable["deliver"]>[0],
  payload: unknown,
) => Promise<void> = async (to, payload) => {
  const address = decodeDeliveryAddress(to);
  if (address.kind === "hook") await resumeHook(address.token, payload);
  else if (address.kind === "session")
    await resumeSessionInbox(address.address, payload as DeliverHookPayload);
  else await resumeSignInCallback(address.token, payload as AuthorizationCallbackPayload);
};

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

export const workflowSessionFor: Durable["sessionFor"] = async (to, options) => {
  const address = decodeDeliveryAddress(to);
  if (address.kind !== "session") throw new Error("Only a session address names a session.");
  const continuationToken = logicalSessionToken(address.address);
  let owner: { sessionId: string };
  try {
    owner = await resolveSessionInbox(continuationToken);
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    let failure = error;
    if (error instanceof StrandedSessionOwnerError) {
      if (options?.runnable === true) throw sessionStrandedError(error.eveVersion);
      try {
        return await resolveStrandedSessionId(error);
      } catch (cause) {
        failure = cause;
      }
    }
    log.error("failed to resolve session by continuation token", {
      error: formatCapabilityError(failure, [continuationToken]),
    });
    throw failure;
  }
  if (options?.runnable !== true) return owner.sessionId;
  try {
    await assertRunnableSessionInbox(
      sessionInboxHookToken(sessionCommandHookToken(owner.sessionId)),
    );
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) throw sessionStrandedError(error.eveVersion);
    throw error;
  }
  return owner.sessionId;
};

export const prewarmWorkflowAddress: NonNullable<Durable["prewarm"]> = async (
  to,
  targetDeploymentId,
) => {
  const address = decodeDeliveryAddress(to);
  return address.kind === "session" && typeof address.address !== "string"
    ? await prewarmWorkflowSession(address.address.sessionId, targetDeploymentId)
    : { status: "unsupported" };
};

export async function assertFollowableWorkflowSession(sessionId: string): Promise<void> {
  try {
    await Promise.all([
      assertRunnableSessionInbox(sessionInboxHookToken(sessionCommandHookToken(sessionId))),
      assertSessionHistoryReadable(builtInHosts(), sessionId),
    ]);
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) throw sessionStrandedError(error.eveVersion);
    throw error;
  }
}

export async function hasRunnableWorkflowOwner(sessionId: string): Promise<boolean> {
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
}

export { readRemoteChildBinding as readWorkflowChildBinding };
