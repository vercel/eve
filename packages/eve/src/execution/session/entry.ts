import {
  workflowInboxTransport,
  type SessionHook,
} from "#execution/session-inbox/workflow-transport.js";
import { runPreparedSession } from "#execution/session/program.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
import { workflowSessionHost } from "#execution/session/workflow-host.js";
import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import {
  bootInitialOwner,
  stampSessionIdentity,
  type BootOutcome,
  type InitialOwnerPorts,
} from "#execution/session/owner-boot.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionInbox,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import { createSessionTimeoutControl } from "#execution/session/timeout-control.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import {
  prepareSuccessorStep,
  readSessionStreamTailStep,
  signalSessionAnchorStep,
  signalSessionOwnerActivationStep,
  endRetiredTaskRunsStep,
} from "#execution/session/handoff-steps.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { preV27Projection, withProjection } from "#execution/session/pre-v27-checkpoint.js";
import type { TaskRunAddress } from "#execution/tasks/table.js";
import {
  HANDOFF_LEASE_RETENTION,
  handoffLeaseToken,
  sendSessionHandover,
  sessionAnchorToken,
} from "#execution/session/handoff.js";
import { type SessionCheckpoint } from "#execution/session/checkpoint.js";
import { abandonHandoverIfRunEnds, watchRunEnd } from "#execution/session/run-watch.js";
import type {
  HandoffWorkflowEntryInput,
  WorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/session/entry-input.js";

export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const boot =
    input.kind === "initial"
      ? await bootInitialOwner(
          input,
          getWorkflowMetadata().workflowRunId,
          workflowOwnerPorts(getWorkflowMetadata().workflowRunId),
        )
      : await bootHandoffOwner(input);
  if (boot === undefined) return { output: "" };
  const result = await runPreparedSession(
    boot.session,
    boot.inbox,
    workflowSessionHost(boot.session, boot.inbox),
  );
  return { output: result.output };
}

export function workflowOwnerPorts(sessionId: string): InitialOwnerPorts<SessionHook> {
  return {
    sessionWritable: getWritable<Uint8Array>(),
    inboxTransport: workflowInboxTransport(sessionId),
    timeouts: createSessionTimeoutControl,
    settleContinuationConflict: (conflict) => settleContinuationConflictStep(conflict),
  };
}

interface PreparedSuccessor {
  readonly checkpoint: SessionCheckpoint;
  readonly serializedContext: Record<string, unknown>;
  readonly importedTurnCount?: number;
  readonly retiredTaskRuns?: readonly TaskRunAddress[];
}

async function prepareSuccessor(
  input: HandoffWorkflowEntryInput,
  source: { readonly runId: string; readonly hookTokens: readonly string[] },
): Promise<PreparedSuccessor | undefined> {
  const { sessionId } = input;
  const migration = migrateSessionCheckpoint(input.checkpoint);
  if (migration.kind === "busy") {
    await signalFailedActivation(input, new Error(migration.detail), { payloads: [] });
    return undefined;
  }
  const validation = await prepareSuccessorStep({
    migration,
    sessionId,
    source,
  });
  if (migration.kind === "incompatible" || validation.kind === "incompatible") {
    await signalSessionOwnerActivationStep({
      activation: {
        kind: "incompatible",
        payloads: [],
        reason: "checkpoint-version",
        runId: getWorkflowMetadata().workflowRunId,
      },
      token: input.activationToken,
    });
    return undefined;
  }
  if (validation.kind === "source-gone") {
    const error = new Error("The session's previous owner no longer holds all of its addresses.");
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  if (migration.kind === "current") {
    const { checkpoint } = migration;
    return {
      checkpoint,
      serializedContext: stampSessionIdentity(checkpoint.serializedContext, sessionId),
    };
  }
  const { checkpoint, retiredRuns, turnCount } = migration.imported;
  return {
    checkpoint,
    importedTurnCount: turnCount,
    retiredTaskRuns: retiredRuns,
    serializedContext: stampSessionIdentity(checkpoint.serializedContext, sessionId),
  };
}

async function placeImportedSession(
  sessionId: string,
  prepared: PreparedSuccessor,
): Promise<PreparedSuccessor> {
  if (prepared.importedTurnCount === undefined) return prepared;
  const tailIndex = await readSessionStreamTailStep({ sessionId });
  const projection = preV27Projection(tailIndex, prepared.importedTurnCount);
  return { ...prepared, checkpoint: withProjection(prepared.checkpoint, projection) };
}

async function signalFailedActivation(
  input: HandoffWorkflowEntryInput,
  error: unknown,
  failure: { readonly claimedHooks?: boolean; readonly payloads: readonly SessionInboxPayload[] },
): Promise<void> {
  await signalSessionOwnerActivationStep({
    activation: {
      error: normalizeSerializableError(error),
      kind: "failed",
      runId: getWorkflowMetadata().workflowRunId,
      ...failure,
    },
    token: input.activationToken,
  });
}

async function bootHandoffOwner(
  input: HandoffWorkflowEntryInput,
): Promise<BootOutcome | undefined> {
  const { attemptKey, hookTokens, sessionId, sourceRunId } = input;
  if (attemptKey === undefined || hookTokens === undefined || sourceRunId === undefined) {
    const error = new Error(
      "Session handoff input is missing attemptKey, hookTokens, or sourceRunId; sources before handoff version 3 are no longer supported.",
    );
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  try {
    const lease = createHook<never>({
      experimental_minRetention: HANDOFF_LEASE_RETENTION,
      token: handoffLeaseToken(attemptKey),
    });
    await claimHookOwnership(lease);
  } catch (error) {
    if (isHookConflictError(error)) return undefined;
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  let prepared: PreparedSuccessor | undefined;
  try {
    prepared = await prepareSuccessor(input, { hookTokens, runId: sourceRunId });
  } catch (error) {
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  if (prepared === undefined) return undefined;
  const inbox = createSessionInbox(workflowInboxTransport(sessionId));
  try {
    await inbox.claimSessionHooks(hookTokens, { force: true, handover: attemptKey });
    prepared = await placeImportedSession(sessionId, prepared);
  } catch (error) {
    const claimedHooks = inbox.claimedTokens.length > 0;
    await signalFailedActivation(input, error, { claimedHooks, payloads: [] });
    if (claimedHooks) await handBack(inbox, { attemptKey, sessionId, sourceRunId });
    await inbox.dispose();
    return undefined;
  }
  abandonHandoverIfRunEnds(inbox, { attemptKey, sourceRunId });
  if (prepared.retiredTaskRuns !== undefined && prepared.retiredTaskRuns.length > 0)
    await endRetiredTaskRunsStep({ runs: prepared.retiredTaskRuns, sessionId });
  return await startSuccessor(input, inbox, prepared);
}

async function handBack(
  inbox: SessionInboxHandle,
  input: { readonly attemptKey: string; readonly sessionId: string; readonly sourceRunId: string },
): Promise<void> {
  const watch = watchRunEnd(input.sourceRunId);
  const settled = new AbortController();
  try {
    const outcome = await Promise.race([
      inbox.whenTakenOver(settled.signal).then(() => "taken-back" as const),
      watch.ended.then(() => "source-ended" as const),
    ]);
    if (outcome === "source-ended") return;
  } finally {
    watch.stop();
    settled.abort();
  }
  await sendSessionHandover({
    attemptKey: input.attemptKey,
    payloads: inbox.drain(),
    sessionId: input.sessionId,
  });
}

async function startSuccessor(
  input: HandoffWorkflowEntryInput,
  inbox: SessionInboxHandle,
  prepared: PreparedSuccessor,
): Promise<BootOutcome> {
  const { sessionId } = input;
  const { checkpoint, serializedContext } = prepared;
  return {
    inbox,
    session: bootFromCheckpoint(checkpoint, {
      anchor: {
        kind: "successor",
        notify: (result) =>
          signalSessionAnchorStep({ result, token: sessionAnchorToken(sessionId) }),
      },
      caller: input.delivery?.caller,
      compactFirst: prepared.importedTurnCount !== undefined && checkpoint.history.length > 0,
      deploymentId: input.ownerDeploymentId,
      serializedContext,
      sessionId,
      sessionTimeoutControl: createSessionTimeoutControl({
        deadline: input.reason === "prewarm" ? input.sessionTimeoutDeadline : undefined,
        sessionId,
        timeoutMs: checkpoint.sessionTimeoutMs,
      }),
      sessionWritable: input.sessionWritable,
      ...(input.delivery !== undefined && { start: { input: input.delivery, kind: "turn" } }),
    }),
  };
}
