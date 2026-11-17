import { readSerializedSessionSchedule } from "#context/session-schedule.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { failSession, runPreparedSession, type SessionBoot } from "#execution/session/program.js";
import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  RunInput,
  SessionCapabilities,
  SessionAuthContext,
} from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionInbox,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import {
  createSessionTimeoutControl,
  type SessionTimeoutControl,
} from "#execution/session/timeout-control.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import {
  SESSION_INBOX_CONTEXT_KEY,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import {
  prepareSuccessorStep,
  readSessionStreamTailStep,
  signalSessionOwnerActivationStep,
} from "#execution/session/handoff-steps.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { preV27Projection, withProjection } from "#execution/session/pre-v27-checkpoint.js";
import {
  HANDOFF_LEASE_RETENTION,
  handoffLeaseToken,
  sendSessionHandover,
  type SessionCheckpoint,
} from "#execution/session/handoff.js";
import { abandonHandoverIfRunEnds, watchRunEnd } from "#execution/session/run-watch.js";
import type {
  HandoffWorkflowEntryInput,
  InitialWorkflowEntryInput,
  WorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/session/entry-input.js";

export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const boot =
    input.kind === "initial"
      ? await bootInitialOwner(input, getWorkflowMetadata().workflowRunId)
      : await bootHandoffOwner(input);
  if (boot === undefined) return { output: "" };
  const result = await runPreparedSession(boot.session, boot.inbox);
  return { output: result.output };
}

interface BootOutcome {
  readonly inbox: SessionInboxHandle;
  readonly session: SessionBoot;
}

function stampSessionIdentity(
  serializedContext: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  return {
    ...serializedContext,
    "eve.sessionId": sessionId,
    [SESSION_INBOX_CONTEXT_KEY]: { sessionId },
  };
}

interface OwnedInitialSession {
  readonly kind: "owned";
  readonly timeoutControl: SessionTimeoutControl | undefined;
  readonly turnControl: TurnControl;
}

type InitialOwnerPreparation = OwnedInitialSession | { readonly kind: "alias-conflict" };

async function prepareInitialOwner(
  inbox: SessionInboxHandle,
  input: {
    readonly continuationToken: string;
    readonly sessionCreation: Promise<unknown>;
    readonly sessionId: string;
    readonly sessionTimeoutMs: number | false;
    readonly startClaim: InitialWorkflowEntryInput["startClaim"];
  },
): Promise<InitialOwnerPreparation> {
  const owner: OwnedInitialSession = {
    kind: "owned",
    timeoutControl: createSessionTimeoutControl({
      sessionId: input.sessionId,
      timeoutMs: input.sessionTimeoutMs,
    }),
    turnControl: createTurnControl(),
  };
  const claim = { confirmAfter: input.sessionCreation };
  const [stableClaim, aliasClaim] = await Promise.allSettled([
    inbox.claimSessionHook(
      sessionCommandHookToken(input.sessionId),
      input.startClaim === "inbox" ? { ...claim, claimedAtStart: true } : claim,
    ),
    input.continuationToken === ""
      ? Promise.resolve()
      : inbox.claimSessionHook(
          input.continuationToken,
          input.startClaim === "continuation" ? { ...claim, claimedAtStart: true } : claim,
        ),
  ]);
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (aliasClaim.status === "rejected") {
    if (isHookConflictError(aliasClaim.reason)) return { kind: "alias-conflict" };
    throw aliasClaim.reason;
  }
  return owner;
}

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export async function bootInitialOwner(
  input: InitialWorkflowEntryInput,
  sessionId: string,
): Promise<BootOutcome | undefined> {
  const serializedContext = stampSessionIdentity(input.serializedContext, sessionId);
  const sessionWritable = getWritable<Uint8Array>();
  const inbox = createSessionInbox(sessionId);
  const sessionTimeoutMs = input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  try {
    const sessionCreationPromise = createSessionStep({
      agentSessionRuntimeOverrides: serializedContext["eve.agentSessionRuntimeOverrides"] as
        | AgentSessionRuntimeOverrides
        | undefined,
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      dynamicSubagentAgentConfig: serializedContext["eve.dynamicSubagentAgentConfig"] as
        | DynamicSubagentAgentConfig
        | undefined,
      history: input.input.message === undefined ? input.input.history : undefined,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: readRootSessionId(serializedContext),
      sessionId,
    });
    const ownerPreparationPromise = prepareInitialOwner(inbox, {
      continuationToken,
      sessionCreation: sessionCreationPromise,
      sessionId,
      sessionTimeoutMs,
      startClaim: input.startClaim,
    });
    const callerResolutionPromise = hasDelegatedSessionContext(serializedContext)
      ? resolveInitialTurnCallerStep({ serializedContext })
      : Promise.resolve(undefined);
    const [sessionCreation, ownerPreparation, callerResolution] = await Promise.allSettled([
      sessionCreationPromise,
      ownerPreparationPromise,
      callerResolutionPromise,
    ]);
    const created = unwrapSettled(sessionCreation);
    const prepared = unwrapSettled(ownerPreparation);
    if (prepared.kind === "alias-conflict") {
      if (input.continuationConflictCommand !== undefined) {
        await settleContinuationConflictStep({
          command: input.continuationConflictCommand,
          continuationToken,
        });
      }
      await inbox.dispose();
      await closeSessionStreamStep({ sessionWritable });
      return undefined;
    }
    const caller = unwrapSettled(callerResolution);
    return {
      inbox,
      session: {
        admittedDeliveryKeys: input.idempotencyKey === undefined ? [] : [input.idempotencyKey],
        anchor: { kind: "self" },
        caller,
        capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
        deploymentId: input.ownerDeploymentId,
        history: created.history,
        start:
          input.input.message === undefined
            ? { kind: "first-message" }
            : { input: createInitialDelivery(input, serializedContext), kind: "turn" },
        initialTurnControl: prepared.turnControl,
        retention: input.retention,
        serializedContext,
        sessionId,
        sessionState: created.state,
        sessionTimeoutControl: prepared.timeoutControl,
        sessionTimeoutMs,
        sessionWritable,
      },
    };
  } catch (error) {
    await inbox.dispose();
    return await failSession({
      error,
      serializedContext,
      sessionId,
      sessionState: undefined,
      sessionWritable,
    });
  }
}

interface PreparedSuccessor {
  readonly checkpoint: SessionCheckpoint;
  readonly serializedContext: Record<string, unknown>;
  readonly importedTurnCount?: number;
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
  const { checkpoint, turnCount } = migration.imported;
  return {
    checkpoint,
    importedTurnCount: turnCount,
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
  const inbox = createSessionInbox(sessionId);
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
    session: {
      anchor: { kind: "successor" },
      admittedDeliveryKeys: checkpoint.admittedDeliveryKeys,
      caller: input.delivery?.caller,
      capabilities: checkpoint.capabilities,
      compactFirst: prepared.importedTurnCount !== undefined && checkpoint.history.length > 0,
      deploymentId: input.ownerDeploymentId,
      history: checkpoint.history,
      start:
        input.delivery !== undefined
          ? { input: input.delivery, kind: "turn" }
          : storedProjection(checkpoint.sessionState.snapshot.session.state).view.session.status ===
              "new"
            ? { kind: "first-message" }
            : { kind: "parked" },
      retention: checkpoint.retention,
      serializedContext,
      sessionId,
      sessionState: checkpoint.sessionState,
      sessionTimeoutControl: createSessionTimeoutControl({
        deadline: input.reason === "prewarm" ? input.sessionTimeoutDeadline : undefined,
        sessionId,
        timeoutMs: checkpoint.sessionTimeoutMs,
      }),
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      sessionWritable: input.sessionWritable,
    },
  };
}

function createInitialDelivery(
  input: InitialWorkflowEntryInput,
  serializedContext: Record<string, unknown>,
): DeliverHookPayload | undefined {
  if (input.input.message === undefined) return undefined;
  return {
    auth: serializedContext["eve.auth"] as SessionAuthContext | null | undefined,
    idempotencyKey: input.idempotencyKey,
    schedule: readSerializedSessionSchedule(serializedContext),
    deliveryMetadata:
      serializedContext["eve.channelDelivery"] === undefined
        ? undefined
        : [
            {
              ...(serializedContext["eve.channelDelivery"] as NonNullable<RunInput["delivery"]>),
              payloadIndex: 0,
            },
          ],
    kind: "deliver",
    payloads: [
      attachClientContext(
        {
          message: input.input.message,
          context: input.input.context,
          history: input.input.history,
          outputSchema: input.input.outputSchema,
          state: input.input.state,
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
