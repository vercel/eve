import { failSession, runPreparedSession, type SessionBoot } from "#execution/session-program.js";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, RunInput, SessionCapabilities } from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { hasDelegatedCallerContext } from "#execution/workflow-entry-crash.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import {
  createSessionInbox,
  claimSessionHooks,
  type SessionInboxHandle,
} from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS, sessionTimeoutDeadline } from "#execution/session-timeout.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import { SESSION_INBOX_CONTEXT_KEY } from "#execution/session-inbox/address.js";
import { signalSessionOwnerActivationStep } from "#execution/session-handoff-steps.js";
import { validateSessionCheckpointStep } from "#execution/session-checkpoint-validation-step.js";
import type {
  HandoffWorkflowEntryInput,
  InitialWorkflowEntryInput,
  WorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/workflow-entry-input.js";

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

  const { workflowRunId: ownerRunId } = getWorkflowMetadata();
  const sessionId = input.kind === "initial" ? ownerRunId : input.checkpoint.ownership.sessionId;
  const serializedContext =
    input.kind === "initial" ? input.serializedContext : { ...input.checkpoint.serializedContext };
  serializedContext["eve.sessionId"] = sessionId;
  serializedContext[SESSION_INBOX_CONTEXT_KEY] = { sessionId };

  const sessionWritable =
    input.kind === "initial" ? getWritable<Uint8Array>() : input.parentWritable;
  const mode: RunMode =
    input.kind === "initial" ? (serializedContext["eve.mode"] as RunMode) : input.checkpoint.mode;
  const sessionInbox = createSessionInbox(sessionId);
  let boot: SessionBoot | undefined;
  try {
    const context = { sessionInbox, ownerRunId, serializedContext, sessionWritable };
    boot =
      input.kind === "initial"
        ? await bootInitialOwner(input, context)
        : await bootHandoffOwner(input, context);
  } catch (error) {
    const payloads = await sessionInbox.release();
    if (input.kind === "handoff") {
      await signalSessionOwnerActivationStep({
        activation: { error: normalizeSerializableError(error), kind: "failed", payloads },
        token: input.activationToken,
      });
      return { output: "" };
    }
    return await failSession({
      error,
      sessionWritable,
      sessionId,
      mode,
      crashCleanupState: {
        caller: undefined,
        callerResolved: false,
        lastSessionState: undefined,
        serializedContext,
        terminalEmitted: false,
      },
    });
  }
  if (boot === undefined) {
    await sessionInbox.dispose();
    return { output: "" };
  }
  const result = await runPreparedSession(boot, sessionInbox);
  return { output: result.output };
}

interface BootContext {
  readonly sessionInbox: SessionInboxHandle;
  readonly ownerRunId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/** Returns `undefined` when a competing continuation owner already exists. */
async function bootInitialOwner(
  input: InitialWorkflowEntryInput,
  context: BootContext,
): Promise<SessionBoot | undefined> {
  const { sessionInbox, ownerRunId: sessionId, serializedContext } = context;
  const { workflowStartedAt } = getWorkflowMetadata();
  const sessionTimeoutMs = input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  const [sessionCreation, stableClaim, aliasClaim] = await Promise.allSettled([
    createSessionStep({
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
      taskId: input.taskId,
    }),
    sessionInbox.claimSessionHook(sessionCommandHookToken(sessionId)),
    continuationToken === "" ? Promise.resolve() : sessionInbox.claimSessionHook(continuationToken),
  ]);
  if (sessionCreation.status === "rejected") throw sessionCreation.reason;
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (aliasClaim.status === "rejected") {
    if (!isHookConflictError(aliasClaim.reason)) throw aliasClaim.reason;
    if (
      input.activityCollectorRunId !== undefined ||
      input.continuationConflictCommand !== undefined
    ) {
      await settleContinuationConflictStep({
        activityCollectorRunId: input.activityCollectorRunId,
        command: input.continuationConflictCommand,
        continuationToken,
      });
    }
    return undefined;
  }

  return {
    anchorToken: `${sessionId}:anchor`,
    caller: hasDelegatedCallerContext(serializedContext)
      ? await resolveInitialTurnCallerStep({ serializedContext })
      : undefined,
    capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
    initialInput: createInitialDelivery(input, serializedContext),
    isInitialOwner: true,
    mode: serializedContext["eve.mode"] as RunMode,
    ownership: {
      anchorRunId: sessionId,
      deploymentId: input.ownerDeploymentId,
      ownerRunId: sessionId,
      sessionId,
    },
    retention: input.retention,
    serializedContext,
    sessionState: sessionCreation.value.state,
    sessionTimeoutMs,
    sessionTimeoutDeadline: sessionTimeoutDeadline(sessionTimeoutMs, workflowStartedAt.getTime()),
    sessionWritable: context.sessionWritable,
  };
}

/** Validates, claims the exact hook set, then tells the previous owner it may exit. */
async function bootHandoffOwner(
  input: HandoffWorkflowEntryInput,
  context: BootContext,
): Promise<SessionBoot> {
  const { checkpoint } = input;
  await validateSessionCheckpointStep({ checkpoint });
  await claimSessionHooks(context.sessionInbox, checkpoint.hooks);
  await signalSessionOwnerActivationStep({
    activation: { kind: "active" },
    token: input.activationToken,
  });
  return {
    anchorToken: checkpoint.anchorToken,
    caller: input.trigger.delivery.caller,
    capabilities: checkpoint.capabilities,
    initialInput: input.trigger.delivery,
    isInitialOwner: false,
    mode: checkpoint.mode,
    ownership: {
      ...checkpoint.ownership,
      deploymentId: input.ownerDeploymentId,
      ownerRunId: context.ownerRunId,
    },
    retention: checkpoint.retention,
    serializedContext: context.serializedContext,
    sessionState: checkpoint.sessionState,
    sessionTimeoutMs: checkpoint.sessionTimeoutMs,
    sessionTimeoutDeadline: sessionTimeoutDeadline(checkpoint.sessionTimeoutMs, Date.now()),
    sessionWritable: context.sessionWritable,
  };
}

function createInitialDelivery(
  input: InitialWorkflowEntryInput,
  serializedContext: Record<string, unknown>,
): DeliverHookPayload {
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
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
