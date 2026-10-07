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
import {
  createPreparedTurnControl,
  type PreparedTurnControl,
} from "#execution/session/turn-control.js";
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

type InitialOwnerPreparation =
  | { readonly kind: "owned"; readonly turnControl: PreparedTurnControl }
  | { readonly kind: "alias-conflict" };

async function prepareInitialOwner(
  inbox: SessionInboxHandle,
  input: {
    readonly continuationToken: string;
    readonly sessionId: string;
    readonly timeoutControl: SessionTimeoutControl | undefined;
  },
): Promise<InitialOwnerPreparation> {
  await inbox.claimSessionHook(sessionCommandHookToken(input.sessionId));
  if (input.continuationToken !== "") {
    try {
      await inbox.claimSessionHook(input.continuationToken);
    } catch (error) {
      if (isHookConflictError(error)) return { kind: "alias-conflict" };
      throw error;
    }
  }

  const turnControl = createPreparedTurnControl();
  try {
    await input.timeoutControl?.start();
    return { kind: "owned", turnControl };
  } catch (error) {
    turnControl.dispose();
    throw error;
  }
}

async function disposeInitialBoot(
  inbox: SessionInboxHandle,
  resources: {
    readonly turnControl: PreparedTurnControl | undefined;
    readonly timeoutControl: SessionTimeoutControl | undefined;
  },
): Promise<void> {
  resources.turnControl?.dispose();
  const [timeoutDisposal, inboxDisposal] = await Promise.allSettled([
    resources.timeoutControl?.dispose(),
    inbox.dispose(),
  ]);
  if (timeoutDisposal.status === "rejected") throw timeoutDisposal.reason;
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
  const { workflowStartedAt } = getWorkflowMetadata();
  const sessionTimeoutMs = input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const deadline = sessionTimeoutDeadline(sessionTimeoutMs, workflowStartedAt.getTime());
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  let turnControl: PreparedTurnControl | undefined;
  let timeoutControl: SessionTimeoutControl | undefined;
  try {
    timeoutControl =
      deadline === undefined ? undefined : createSessionTimeoutControl({ deadline, sessionId });
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
      sessionId,
      timeoutControl,
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
      turnControl = ownerPreparation.value.turnControl;
    }
    if (sessionCreation.status === "rejected") throw sessionCreation.reason;
    if (ownerPreparation.status === "rejected") throw ownerPreparation.reason;
    if (ownerPreparation.value.kind === "alias-conflict") {
      if (input.continuationConflictCommand !== undefined) {
        await settleContinuationConflictStep({
          command: input.continuationConflictCommand,
          continuationToken,
        });
      }
      await disposeInitialBoot(inbox, { turnControl, timeoutControl });
      return undefined;
    }
    if (callerResolution.status === "rejected") throw callerResolution.reason;
    return {
      inbox,
      session: {
        anchor: { kind: "self" },
        caller: callerResolution.value,
        capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
        deploymentId: input.ownerDeploymentId,
        history: sessionCreation.value.history,
        start:
          input.input.message === undefined
            ? { kind: "first-message" }
            : { input: createInitialDelivery(input, serializedContext), kind: "turn" },
        prestartedControls: {
          timeoutControl,
          turnControl: ownerPreparation.value.turnControl,
        },
        retention: input.retention,
        serializedContext,
        sessionId,
        sessionState: sessionCreation.value.state,
        sessionTimeoutMs,
        sessionTimeoutDeadline: deadline,
        sessionWritable,
      },
    };
  } catch (error) {
    await disposeInitialBoot(inbox, { turnControl, timeoutControl });
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
  const compaction = input.reason === "compaction";
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
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      // A deployment handoff renews the configured lifetime; compaction keeps the deadline.
      sessionTimeoutDeadline: compaction
        ? input.sessionTimeoutDeadline
        : sessionTimeoutDeadline(checkpoint.sessionTimeoutMs, Date.now()),
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
