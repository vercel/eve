import { readSerializedSessionSchedule } from "#context/session-schedule.js";
import { failSession, runPreparedSession, type SessionBoot } from "#execution/session/program.js";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, RunInput, SessionCapabilities } from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { createSessionInbox, type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { DEFAULT_SESSION_TIMEOUT_MS, sessionTimeoutDeadline } from "#execution/session/timeout.js";
import {
  createSessionTimeoutControl,
  type SessionTimeoutControl,
} from "#execution/session/timeout-control.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import {
  SESSION_INBOX_CONTEXT_KEY,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import {
  signalSessionOwnerActivationStep,
  stopUntrackedChildSessionsStep,
  validateSessionCheckpointStep,
} from "#execution/session/handoff-steps.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
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
  dispose(): Promise<void>;
}

type InitialOwnerPreparation = OwnedInitialSession | { readonly kind: "alias-conflict" };

async function prepareInitialOwner(
  inbox: SessionInboxHandle,
  input: {
    readonly continuationToken: string;
    readonly deadline: Date | undefined;
    readonly sessionId: string;
  },
): Promise<InitialOwnerPreparation> {
  const [stableClaim, aliasClaim] = await Promise.allSettled([
    inbox.claimSessionHook(sessionCommandHookToken(input.sessionId)),
    input.continuationToken === ""
      ? Promise.resolve()
      : inbox.claimSessionHook(input.continuationToken),
  ]);
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (aliasClaim.status === "rejected") {
    if (isHookConflictError(aliasClaim.reason)) return { kind: "alias-conflict" };
    throw aliasClaim.reason;
  }

  const turnControl = createTurnControl();
  const timeoutControl =
    input.deadline === undefined
      ? undefined
      : createSessionTimeoutControl({ deadline: input.deadline, sessionId: input.sessionId });
  const owner: OwnedInitialSession = {
    kind: "owned",
    timeoutControl,
    turnControl,
    async dispose() {
      turnControl.dispose();
      await timeoutControl?.dispose();
    },
  };
  // The session loop joins this startup. Handling the promise here prevents a
  // rejection from becoming unhandled if another boot branch fails first.
  void timeoutControl?.start().catch(() => {});
  return owner;
}

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function disposeInitialBoot(
  inbox: SessionInboxHandle,
  owner: OwnedInitialSession | undefined,
): Promise<void> {
  const [ownerDisposal, inboxDisposal] = await Promise.allSettled([
    owner?.dispose(),
    inbox.dispose(),
  ]);
  if (ownerDisposal.status === "rejected") throw ownerDisposal.reason;
  if (inboxDisposal.status === "rejected") throw inboxDisposal.reason;
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
  // Workflow's clock is replay-stable; its optimistic startedAt metadata is not.
  const deadline = sessionTimeoutDeadline(sessionTimeoutMs, Date.now());
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  let owner: OwnedInitialSession | undefined;
  try {
    const sessionCreationPromise = createSessionStep({
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      dynamicSubagentAgentConfig: serializedContext["eve.dynamicSubagentAgentConfig"] as
        | DynamicSubagentAgentConfig
        | undefined,
      inheritedLimits: input.limits,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: readRootSessionId(serializedContext),
      sessionId,
    });
    const ownerPreparationPromise = prepareInitialOwner(inbox, {
      continuationToken,
      deadline,
      sessionId,
    });
    const callerResolutionPromise = hasDelegatedSessionContext(serializedContext)
      ? resolveInitialTurnCallerStep({ serializedContext })
      : Promise.resolve(undefined);
    const [sessionCreation, ownerPreparation, callerResolution] = await Promise.allSettled([
      sessionCreationPromise,
      ownerPreparationPromise,
      callerResolutionPromise,
    ]);
    if (ownerPreparation.status === "fulfilled" && ownerPreparation.value.kind === "owned") {
      owner = ownerPreparation.value;
    }
    const created = unwrapSettled(sessionCreation);
    const prepared = unwrapSettled(ownerPreparation);
    if (prepared.kind === "alias-conflict") {
      if (input.continuationConflictCommand !== undefined) {
        await settleContinuationConflictStep({
          command: input.continuationConflictCommand,
          continuationToken,
        });
      }
      await disposeInitialBoot(inbox, owner);
      return undefined;
    }
    const caller = unwrapSettled(callerResolution);
    return {
      inbox,
      session: {
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
        sessionTimeoutDeadline: deadline,
        sessionWritable,
      },
    };
  } catch (error) {
    await disposeInitialBoot(inbox, owner);
    return await failSession({
      error,
      serializedContext,
      sessionId,
      sessionState: undefined,
      sessionWritable,
    });
  }
}

/** Validates, claims the exact hook set, then tells the previous owner it may exit. */
async function bootHandoffOwner(
  input: HandoffWorkflowEntryInput,
): Promise<BootOutcome | undefined> {
  const { sessionId } = input;
  const inbox = createSessionInbox(sessionId);
  let checkpoint: SessionCheckpoint;
  let childRunIdsToStop: readonly string[];
  let serializedContext: Record<string, unknown>;
  try {
    // The previous owner may run an older eve build; read its checkpoint in this build's shape.
    const migration = migrateSessionCheckpoint(input.checkpoint);
    const validation = await validateSessionCheckpointStep({ migration, sessionId });
    if (migration.kind === "incompatible" || validation.kind === "incompatible") {
      const payloads = await inbox.release();
      await signalSessionOwnerActivationStep({
        activation: { kind: "incompatible", payloads, reason: "checkpoint-version" },
        token: input.activationToken,
      });
      return undefined;
    }
    ({ checkpoint, childRunIdsToStop } = migration);
    serializedContext = stampSessionIdentity(checkpoint.serializedContext, sessionId);
    await inbox.claimSessionHooks(
      sessionHookTokens({ serializedContext, sessionState: checkpoint.sessionState }),
    );
    await signalSessionOwnerActivationStep({
      activation: { kind: "active" },
      token: input.activationToken,
    });
  } catch (error) {
    const payloads = await inbox.release();
    await signalSessionOwnerActivationStep({
      activation: { error: normalizeSerializableError(error), kind: "failed", payloads },
      token: input.activationToken,
    });
    return undefined;
  }
  if (childRunIdsToStop.length > 0) {
    await stopUntrackedChildSessionsStep({ runIds: childRunIdsToStop, sessionId });
  }
  const deadline =
    input.reason === "compaction"
      ? input.sessionTimeoutDeadline
      : sessionTimeoutDeadline(checkpoint.sessionTimeoutMs, Date.now());
  const timeoutControl =
    deadline === undefined ? undefined : createSessionTimeoutControl({ deadline, sessionId });
  return {
    inbox,
    session: {
      anchor: { kind: "successor" },
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
      sessionTimeoutControl: timeoutControl,
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      // A deployment handoff renews the configured lifetime; compaction keeps the deadline.
      sessionTimeoutDeadline: deadline,
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
          outputSchema: input.input.outputSchema,
          state: input.input.state,
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
