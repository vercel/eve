import { readSerializedSessionSchedule } from "#context/session-schedule.js";
import { failSession, runPreparedSession, type SessionBoot } from "#execution/session/program.js";
import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, RunInput, SessionCapabilities } from "#channel/types.js";
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
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
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
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import {
  SESSION_INBOX_CONTEXT_KEY,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import {
  prepareSuccessorStep,
  signalSessionOwnerActivationStep,
  stopUntrackedChildSessionsStep,
} from "#execution/session/handoff-steps.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
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

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

/**
 * Long-lived workflow entrypoint. Handles both root sessions and
 * delegated child sessions: root sessions expose only parent
 * control-plane events; delegated children publish their full progress
 * on a child stream and resume the parked parent with a
 * `subagent-result` on completion.
 *
 * The current owner directly executes every turn. An idle owner can transfer
 * its settled checkpoint and hooks to an exact successor deployment while the
 * original run remains parked as the public stream anchor.
 */
export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const boot =
    input.kind === "initial"
      ? await bootInitialOwner(input, getWorkflowMetadata().workflowRunId)
      : (input.handoffVersion ?? 0) >= 3
        ? await bootForcedHandoffOwner(input)
        : await bootReleasedHandoffOwner(input);
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
    /** The claims confirm after it, so it runs inline while their hooks commit. */
    readonly sessionCreation: Promise<unknown>;
    readonly sessionId: string;
    readonly sessionTimeoutMs: number | false;
  },
): Promise<InitialOwnerPreparation> {
  const owner: OwnedInitialSession = {
    kind: "owned",
    // The session loop starts the timer once the claims are confirmed; one
    // started sooner could signal a command hook that is not registered yet.
    timeoutControl: createSessionTimeoutControl({
      sessionId: input.sessionId,
      timeoutMs: input.sessionTimeoutMs,
    }),
    // Created before any await so its abort hooks commit with the session's
    // hooks instead of beside the first turn's step.
    turnControl: createTurnControl(),
  };
  const claim = { confirmAfter: input.sessionCreation };
  const [stableClaim, aliasClaim] = await Promise.allSettled([
    inbox.claimSessionHook(sessionCommandHookToken(input.sessionId), claim),
    input.continuationToken === ""
      ? Promise.resolve()
      : inbox.claimSessionHook(input.continuationToken, claim),
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

/** Returns `undefined` when a competing continuation owner already exists. */
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
      // With a first message, its delivery carries the history instead.
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

/** A successor that may continue the session, before it owns any of its hooks. */
interface PreparedSuccessor {
  readonly checkpoint: SessionCheckpoint;
  readonly childRunIdsToStop: readonly string[];
  readonly serializedContext: Record<string, unknown>;
}

/** Migrates and validates the checkpoint; tells the source and returns `undefined` when it is unreadable here. */
async function prepareSuccessor(
  input: HandoffWorkflowEntryInput,
  source?: { readonly runId: string; readonly hookTokens: readonly string[] },
): Promise<PreparedSuccessor | undefined> {
  const { sessionId } = input;
  // The previous owner may run an older eve build; read its checkpoint in this build's shape.
  const migration = migrateSessionCheckpoint(input.checkpoint);
  const validation = await prepareSuccessorStep({
    handoffVersion: input.handoffVersion,
    migration,
    sessionId,
    ...(source !== undefined && { source }),
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
    // A source that ended no longer listens; a live one keeps the session.
    const error = new Error("The session's previous owner no longer holds all of its addresses.");
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  const { checkpoint, childRunIdsToStop } = migration;
  return {
    checkpoint,
    childRunIdsToStop,
    serializedContext: stampSessionIdentity(checkpoint.serializedContext, sessionId),
  };
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

/**
 * Version 3: the source still holds every hook. Fences duplicate candidates,
 * prepares, then force-claims the source's hook set and runs right away; the
 * source's handover is placed ahead of everything this run accepts itself.
 */
async function bootForcedHandoffOwner(
  input: HandoffWorkflowEntryInput,
): Promise<BootOutcome | undefined> {
  const { attemptKey, hookTokens, sessionId, sourceRunId } = input;
  if (attemptKey === undefined || hookTokens === undefined || sourceRunId === undefined) {
    const error = new Error(
      "Session handoff version 3 input is missing attemptKey, hookTokens, or sourceRunId.",
    );
    await signalFailedActivation(input, error, { payloads: [] });
    return undefined;
  }
  try {
    // A start step retried after its run was created leaves a duplicate
    // candidate, and an owner whose start step failed takes the lease itself.
    // Only one run claims it; the token stays reserved past that run's end.
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

/**
 * Waits for the source to take its hooks back, then returns what this run
 * accepted meanwhile as the handover. A source that ended takes nothing back.
 */
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

/**
 * A source older than version 3 already released its hooks: claim them
 * ordinarily and tell the source it may exit.
 */
async function bootReleasedHandoffOwner(
  input: HandoffWorkflowEntryInput,
): Promise<BootOutcome | undefined> {
  const inbox = createSessionInbox(input.sessionId);
  let prepared: PreparedSuccessor | undefined;
  try {
    prepared = await prepareSuccessor(input);
    if (prepared === undefined) return undefined;
    await inbox.claimSessionHooks(
      sessionHookTokens({
        serializedContext: prepared.serializedContext,
        sessionState: prepared.checkpoint.sessionState,
      }),
    );
    await signalSessionOwnerActivationStep({
      activation: { kind: "active" },
      token: input.activationToken,
    });
  } catch (error) {
    await signalFailedActivation(input, error, { payloads: await inbox.release() });
    return undefined;
  }
  return await startSuccessor(input, inbox, prepared);
}

async function startSuccessor(
  input: HandoffWorkflowEntryInput,
  inbox: SessionInboxHandle,
  prepared: PreparedSuccessor,
): Promise<BootOutcome> {
  const { sessionId } = input;
  const { checkpoint, childRunIdsToStop, serializedContext } = prepared;
  if (childRunIdsToStop.length > 0) {
    await stopUntrackedChildSessionsStep({ runIds: childRunIdsToStop, sessionId });
  }
  return {
    inbox,
    session: {
      anchor: { kind: "successor" },
      admittedDeliveryKeys: checkpoint.admittedDeliveryKeys,
      caller: input.delivery?.caller,
      capabilities: checkpoint.capabilities,
      deploymentId: input.ownerDeploymentId,
      history: checkpoint.history,
      start:
        input.delivery === undefined ? { kind: "parked" } : { input: input.delivery, kind: "turn" },
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
