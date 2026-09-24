import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";

import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type {
  HandoffWorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/session/entry-input.js";
import { startSessionOwnerStep } from "#execution/workflow-runtime.js";
import {
  forwardSessionInputStep,
  isSessionIdleForHandoffStep,
  validateSessionCheckpointStep,
} from "#execution/session/handoff-steps.js";
import {
  SESSION_CHECKPOINT_VERSION,
  sessionAnchorToken,
  type SessionCheckpoint,
  type SessionHandoff,
  type SessionHandoffInput,
  type SessionOwnerActivation,
  type SessionTransferOutcome,
} from "#execution/session/handoff.js";

/**
 * Keeps every hook while the successor force-claims them. Each forced claim
 * moves one token atomically, so the session is never unowned.
 */
export class TakeoverSessionHandoff implements SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  async tryTransfer(
    selection: TurnSelection,
    state: Pick<SessionCheckpoint, "serializedContext" | "sessionState">,
  ): Promise<SessionTransferOutcome> {
    const { deploymentId, inbox, sessionId } = this.input;
    const targetDeploymentId = readAcceptedDeploymentId(selection.delivery);
    if (targetDeploymentId === undefined) return { kind: "retained", reason: "missing-deployment" };
    if (targetDeploymentId === deploymentId) return { kind: "retained", reason: "same-deployment" };
    if (!selection.handoffEligible) return { kind: "retained", reason: "busy" };
    if (!(await isSessionIdleForHandoffStep(state)))
      return { kind: "retained", reason: "not-idle" };
    // A backlog is never transferred to salvage a handoff.
    if (inbox.hasPending()) return { kind: "retained", reason: "busy" };

    await this.ensureAnchor();
    const activation = createHook<SessionOwnerActivation>({
      token: `${getWorkflowMetadata().workflowRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      await startSessionOwnerStep({
        activationToken: activation.token,
        anchorRunId: sessionId,
        checkpoint: { ...this.input.checkpoint, ...state, version: SESSION_CHECKPOINT_VERSION },
        delivery: selection.delivery,
        targetDeploymentId,
      });
      if ((await activation).kind === "failed") {
        return { kind: "retained", reason: "activation-failed" };
      }
    } catch {
      // Nothing was taken before activation, so this owner keeps the session.
      return { kind: "retained", reason: "activation-failed" };
    } finally {
      await disposeHook(activation);
    }
    // The takeover ended every reader after it delivered what its hook had
    // accepted, so this is exactly what arrived before the successor owned the
    // session. It trails anything already sent to the successor directly.
    const accepted = inbox.drain();
    if (accepted.length > 0) await forwardSessionInputStep({ payloads: accepted, sessionId });
    return { kind: "transferred" };
  }

  async awaitAnchoredResult(): Promise<WorkflowEntryResult> {
    if (this.anchor === undefined) throw new Error("Session anchor was never claimed.");
    try {
      return await this.anchor;
    } finally {
      await this.disposeAnchor();
    }
  }

  async disposeAnchor(): Promise<void> {
    if (this.anchor === undefined) return;
    const anchor = this.anchor;
    this.anchor = undefined;
    await disposeHook(anchor);
  }

  private async ensureAnchor(): Promise<void> {
    // Only the original run outlives successors; intermediate owners exit.
    if (!this.input.isInitialOwner || this.anchor !== undefined) return;
    this.anchor = createHook<WorkflowEntryResult>({
      token: sessionAnchorToken(this.input.sessionId),
    });
    await claimHookOwnership(this.anchor);
  }
}

/**
 * Takes every session hook from a source whose run supports forced claims.
 * Returns false when another start of this same attempt already won; that run
 * reports to the source.
 */
export async function takeOverSession(
  input: HandoffWorkflowEntryInput,
  inbox: Pick<SessionInboxHandle, "forceClaimSessionHook">,
  tokens: readonly string[],
): Promise<boolean> {
  // A re-run start step can boot this attempt twice, and forced claims would
  // let the second take the session from the first. A plain claim on a token
  // unique to the attempt fences them. It registers alongside validation and
  // is read once validation returns, so validation still runs inline.
  const fence = createHook<never>({
    token: `${input.activationToken}:${input.delivery.deliveryMetadata?.[0]?.deliveryId ?? ""}`,
  });
  await validateSessionCheckpointStep({ checkpoint: input.checkpoint });
  try {
    await claimHookOwnership(fence);
  } catch (error) {
    if (isHookConflictError(error)) return false;
    throw error;
  }
  // Every claim settles before a refusal propagates, so release sees them all.
  const outcomes = await Promise.allSettled(
    tokens.map((token) => inbox.forceClaimSessionHook(token)),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  return true;
}
