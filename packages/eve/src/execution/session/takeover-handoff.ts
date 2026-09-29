import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type {
  HandoffWorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/session/entry-input.js";
import { startSessionOwnerStep } from "#execution/workflow-runtime.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  forwardSessionInputStep,
  isSessionIdleForHandoffStep,
  logSessionHandoffStep,
  supportsSessionTakeoverStep,
  validateSessionCheckpointStep,
} from "#execution/session/handoff-steps.js";
import { LegacySessionHandoff } from "#execution/session/legacy-handoff.js";
import {
  SESSION_CHECKPOINT_VERSION,
  sessionAnchorToken,
  type SessionCheckpoint,
  type SessionHandoff,
  type SessionHandoffInput,
  type SessionHandoffProtocol,
  type SessionOwnerActivation,
  type SessionTransferOutcome,
} from "#execution/session/handoff.js";

/**
 * Keeps every hook while the successor force-claims them. Each forced claim
 * moves one token atomically, so the session is never unowned. On a World that
 * cannot force-claim or retain hooks, every handoff is release-first instead.
 */
export class TakeoverSessionHandoff implements SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;
  private releaseFirst: LegacySessionHandoff | undefined;
  private supported: boolean | undefined;

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  async tryTransfer(
    selection: TurnSelection,
    state: Pick<SessionCheckpoint, "serializedContext" | "sessionState">,
  ): Promise<SessionTransferOutcome> {
    const targetDeploymentId = readAcceptedDeploymentId(selection.delivery);
    if (targetDeploymentId === undefined) return { kind: "retained", reason: "missing-deployment" };
    if (targetDeploymentId === this.input.deploymentId)
      return { kind: "retained", reason: "same-deployment" };
    if (!selection.handoffEligible) return { kind: "retained", reason: "busy" };
    this.supported ??= await supportsSessionTakeoverStep();
    if (this.supported) return await this.takeOver(selection, state, targetDeploymentId);
    this.releaseFirst ??= new LegacySessionHandoff(this.input);
    const outcome = await this.releaseFirst.tryTransfer(selection, state);
    await this.report({ outcome, protocol: "release", targetDeploymentId });
    return outcome;
  }

  private async takeOver(
    selection: TurnSelection,
    state: Pick<SessionCheckpoint, "serializedContext" | "sessionState">,
    targetDeploymentId: string,
  ): Promise<SessionTransferOutcome> {
    const { inbox, sessionId } = this.input;
    if (!(await isSessionIdleForHandoffStep(state)))
      return { kind: "retained", reason: "not-idle" };
    // A backlog is never transferred to salvage a handoff.
    if (inbox.hasPending()) return { kind: "retained", reason: "busy" };

    await this.ensureAnchor();
    const activation = createHook<SessionOwnerActivation>({
      token: `${getWorkflowMetadata().workflowRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    inbox.allowTakeover(true);
    let outcome: SessionOwnerActivation;
    try {
      outcome = await this.startAndActivate(activation, {
        checkpoint: { ...this.input.checkpoint, ...state, version: SESSION_CHECKPOINT_VERSION },
        delivery: selection.delivery,
        targetDeploymentId,
      });
    } finally {
      await disposeHook(activation);
    }
    if (outcome.kind === "failed") {
      await this.recover(outcome.payloads);
      const retained = { kind: "retained", reason: "activation-failed" } as const;
      await this.report({
        error: outcome.error,
        outcome: retained,
        protocol: "takeover",
        targetDeploymentId,
      });
      return retained;
    }
    // The takeover ended every reader after it delivered what its hook had
    // accepted, so this is exactly what arrived before the successor owned the
    // session. It trails anything already sent to the successor directly.
    const forwarding = await forwardAccepted(inbox.drain(), sessionId);
    const transferred = { kind: "transferred" } as const;
    await this.report({
      ...forwarding,
      outcome: transferred,
      protocol: "takeover",
      targetDeploymentId,
    });
    return transferred;
  }

  /**
   * Logs each attempted handoff. A turn that never tries to move, or defers
   * because the session is busy, logs nothing and so costs no extra step.
   */
  private async report(input: {
    readonly error?: unknown;
    readonly forwarded?: number;
    readonly outcome: SessionTransferOutcome;
    readonly protocol: SessionHandoffProtocol;
    readonly targetDeploymentId: string;
    readonly unforwarded?: number;
  }): Promise<void> {
    const { outcome } = input;
    const fields: Record<string, unknown> = {
      deploymentId: this.input.deploymentId,
      protocol: input.protocol,
      sessionId: this.input.sessionId,
      targetDeploymentId: input.targetDeploymentId,
    };
    if (input.forwarded !== undefined) fields.forwarded = input.forwarded;
    if (input.unforwarded !== undefined) fields.unforwarded = input.unforwarded;
    if (input.error !== undefined) fields.error = input.error;
    if (outcome.kind === "transferred") {
      await logSessionHandoffStep(
        input.unforwarded === undefined
          ? { fields, level: "info", message: "session handed off to another deployment" }
          : {
              fields,
              level: "warn",
              message:
                "session handed off, but input accepted before the handoff could not be forwarded",
            },
      );
      return;
    }
    fields.reason = outcome.reason;
    if (outcome.reason === "activation-failed") {
      await logSessionHandoffStep({
        fields,
        level: "warn",
        message: "session handoff failed; the current owner kept the session",
      });
    } else if (outcome.reason === "accepted-during-release") {
      await logSessionHandoffStep({
        fields,
        level: "info",
        message: "session handoff deferred; input arrived while the addresses were released",
      });
    }
  }

  async awaitAnchoredResult(): Promise<WorkflowEntryResult> {
    if (this.releaseFirst !== undefined) return await this.releaseFirst.awaitAnchoredResult();
    if (this.anchor === undefined) throw new Error("Session anchor was never claimed.");
    try {
      return await this.anchor;
    } finally {
      await this.disposeAnchor();
    }
  }

  async disposeAnchor(): Promise<void> {
    await this.releaseFirst?.disposeAnchor();
    if (this.anchor === undefined) return;
    const anchor = this.anchor;
    this.anchor = undefined;
    await disposeHook(anchor);
  }

  private async startAndActivate(
    activation: Hook<SessionOwnerActivation>,
    start: {
      readonly checkpoint: SessionCheckpoint;
      readonly delivery: DeliverHookPayload;
      readonly targetDeploymentId: string;
    },
  ): Promise<SessionOwnerActivation> {
    try {
      await startSessionOwnerStep({
        ...start,
        activationToken: activation.token,
        anchorRunId: this.input.sessionId,
      });
    } catch (error) {
      // The failed start may still have created the successor. Holding its
      // attempt fence keeps that run from ever taking the session; if it
      // already holds the fence, it reports here.
      const fence = createAttemptFence(attemptFenceToken(activation.token, start.delivery));
      try {
        await claimHookOwnership(fence);
        return { error: normalizeSerializableError(error), kind: "failed", payloads: [] };
      } catch (fenceError) {
        if (!isHookConflictError(fenceError)) throw fenceError;
      }
    }
    return await activation;
  }

  /**
   * Takes back whatever a failed successor took. What it accepted arrived
   * after everything this owner already holds.
   */
  private async recover(payloads: readonly SessionInboxPayload[]): Promise<void> {
    const { inbox } = this.input;
    inbox.enqueue(payloads);
    if (inbox.takenTokens.length > 0) await inbox.claim(inbox.takenTokens);
    inbox.allowTakeover(false);
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

/** The successor already owns the session, so a forwarding failure is reported, not retried. */
async function forwardAccepted(
  accepted: readonly SessionInboxPayload[],
  sessionId: string,
): Promise<{
  readonly error?: unknown;
  readonly forwarded: number;
  readonly unforwarded?: number;
}> {
  let forwarded = 0;
  for (const payload of accepted) {
    try {
      // A session that already ended has no one to receive the rest.
      if (!(await forwardSessionInputStep({ payload, sessionId }))) break;
      forwarded++;
    } catch (error) {
      return {
        error: normalizeSerializableError(error),
        forwarded,
        unforwarded: accepted.length - forwarded,
      };
    }
  }
  return { forwarded };
}

function attemptFenceToken(activationToken: string, delivery: DeliverHookPayload): string {
  const deliveryId = delivery.deliveryMetadata?.[0]?.deliveryId;
  if (deliveryId === undefined) throw new Error("A handoff trigger must carry a delivery id.");
  return `${activationToken}:${deliveryId}`;
}

/** Retention keeps the fence taken after its holder ends, when later owners hold the session. */
function createAttemptFence(token: string): Hook<never> {
  return createHook<never>({ token, experimental_minRetention: "1d" });
}

/**
 * Takes every session hook from a source whose run supports forced claims.
 * Returns false when another start of this same attempt, or the source
 * itself, already holds the attempt; the holder reports to the source.
 */
export async function takeOverSession(
  input: HandoffWorkflowEntryInput,
  inbox: Pick<SessionInboxHandle, "claim">,
  tokens: readonly string[],
): Promise<boolean> {
  // A re-run start step can boot this attempt twice, at any time, and forced
  // claims would let the second take the session from whoever owns it then.
  // A plain claim on a token unique to the attempt fences them. It is written
  // in the same suspension as validation and read after validation returns,
  // so validation still runs inline.
  const fence = createAttemptFence(attemptFenceToken(input.activationToken, input.delivery));
  await validateSessionCheckpointStep({ checkpoint: input.checkpoint });
  try {
    await claimHookOwnership(fence);
  } catch (error) {
    if (isHookConflictError(error)) return false;
    throw error;
  }
  // A refused claim must surface before the source is told to leave.
  await inbox.claim(tokens);
  return true;
}
