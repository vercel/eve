import { failSession, runPreparedSession, type SessionBoot } from "#execution/session/program.js";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, RunInput, SessionCapabilities } from "#channel/types.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { createSessionInbox, type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { DEFAULT_SESSION_TIMEOUT_MS, sessionTimeoutDeadline } from "#execution/session/timeout.js";
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
  validateSessionCheckpointStep,
} from "#execution/session/handoff-steps.js";
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

/** Returns `undefined` when a competing continuation owner already exists. */
async function bootInitialOwner(
  input: InitialWorkflowEntryInput,
  sessionId: string,
): Promise<BootOutcome | undefined> {
  const serializedContext = stampSessionIdentity(input.serializedContext, sessionId);
  const sessionWritable = getWritable<Uint8Array>();
  const mode = serializedContext["eve.mode"] as RunMode;
  const inbox = createSessionInbox(sessionId);
  const { workflowStartedAt } = getWorkflowMetadata();
  const sessionTimeoutMs = input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  try {
    if (input.input.message === undefined && mode !== "conversation") {
      throw new Error("A message-free session must use conversation mode.");
    }
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
      inbox.claimSessionHook(sessionCommandHookToken(sessionId)),
      continuationToken === "" ? Promise.resolve() : inbox.claimSessionHook(continuationToken),
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
      await inbox.dispose();
      return undefined;
    }
    return {
      inbox,
      session: {
        anchor: { kind: "self" },
        caller: hasDelegatedSessionContext(serializedContext)
          ? await resolveInitialTurnCallerStep({ serializedContext })
          : undefined,
        capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
        deploymentId: input.ownerDeploymentId,
        initialInput: createInitialDelivery(input, serializedContext),
        awaitFirstMessage: input.input.message === undefined,
        mode,
        retention: input.retention,
        serializedContext,
        sessionId,
        sessionState: sessionCreation.value.state,
        sessionTimeoutMs,
        sessionTimeoutDeadline: sessionTimeoutDeadline(
          sessionTimeoutMs,
          workflowStartedAt.getTime(),
        ),
        sessionWritable,
      },
    };
  } catch (error) {
    await inbox.dispose();
    return await failSession({
      error,
      mode,
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
  const { checkpoint, sessionId } = input;
  const serializedContext = stampSessionIdentity(checkpoint.serializedContext, sessionId);
  const inbox = createSessionInbox(sessionId);
  try {
    await validateSessionCheckpointStep({ checkpoint });
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
  return {
    inbox,
    session: {
      anchor: { kind: "successor" },
      caller: input.delivery.caller,
      capabilities: checkpoint.capabilities,
      deploymentId: input.ownerDeploymentId,
      initialInput: input.delivery,
      awaitFirstMessage: false,
      mode: checkpoint.mode,
      retention: checkpoint.retention,
      serializedContext,
      sessionId,
      sessionState: checkpoint.sessionState,
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      sessionTimeoutDeadline: sessionTimeoutDeadline(checkpoint.sessionTimeoutMs, Date.now()),
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
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
