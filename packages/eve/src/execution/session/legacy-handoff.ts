import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type {
  HandoffWorkflowEntryInput,
  WorkflowEntryResult,
} from "#execution/session/entry-input.js";
import { startSessionOwnerStep } from "#execution/workflow-runtime.js";
import { sessionHandoffMarkerToken } from "#execution/session-inbox/address.js";
import {
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

/*
 * The release-first handoff that predates forced hook claims, unchanged. It
 * serves only owners whose run was started on a Workflow spec that cannot be
 * taken from: successors of version 1 sources and imported pre-cutover
 * sessions. Delete this module, the handoff markers, and the ingress retry in
 * `session-inbox/resume.ts` once no such owner can exist.
 */

/** Version 1 sources omit the handoff version. */
export function isLegacyHandoff(input: Pick<HandoffWorkflowEntryInput, "handoffVersion">): boolean {
  return input.handoffVersion === undefined;
}

/** Claims the exact hook set a version 1 source released before starting this successor. */
export async function adoptReleasedSession(
  input: HandoffWorkflowEntryInput,
  inbox: Pick<SessionInbox, "claimSessionHooks">,
  tokens: readonly string[],
): Promise<void> {
  await validateSessionCheckpointStep({ checkpoint: input.checkpoint });
  await inbox.claimSessionHooks(tokens);
}

/** Releases every hook before starting the successor, leaving the session briefly unowned. */
export class LegacySessionHandoff implements SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  /**
   * Attempts to move the session to the selected delivery's deployment. The
   * outcome states whether the successor activated or this owner retained the
   * session. Candidate failures recover locally rather than escaping.
   */
  async tryTransfer(
    selection: TurnSelection,
    state: Pick<SessionCheckpoint, "serializedContext" | "sessionState">,
  ): Promise<SessionTransferOutcome> {
    const { deploymentId, inbox } = this.input;
    const targetDeploymentId = readAcceptedDeploymentId(selection.delivery);
    if (targetDeploymentId === undefined) return { kind: "retained", reason: "missing-deployment" };
    if (targetDeploymentId === deploymentId) return { kind: "retained", reason: "same-deployment" };
    if (!selection.handoffEligible) return { kind: "retained", reason: "busy" };
    if (!(await isSessionIdleForHandoffStep(state)))
      return { kind: "retained", reason: "not-idle" };

    const checkpoint: SessionCheckpoint = {
      ...this.input.checkpoint,
      ...state,
      version: SESSION_CHECKPOINT_VERSION,
    };
    const tokens = sessionHookTokens(state);
    await this.ensureAnchor();

    // Markers let ingress distinguish a session mid-handoff from an address
    // nobody owns, so a concurrent channel delivery retries instead of
    // creating a replacement session on the released alias.
    const markers = tokens.map((token) =>
      createHook<never>({ token: sessionHandoffMarkerToken(token) }),
    );
    await Promise.all(markers.map((marker) => claimHookOwnership(marker)));
    try {
      const acceptedDuringRelease = await inbox.release();
      if (acceptedDuringRelease.length > 0) {
        await this.recover(tokens, acceptedDuringRelease);
        return { kind: "retained", reason: "accepted-during-release" };
      }
      let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
      try {
        const activation = await this.startAndActivate(
          checkpoint,
          selection.delivery,
          targetDeploymentId,
        );
        if (activation.kind === "active") return { kind: "transferred" };
        acceptedByFailedCandidate = activation.payloads;
      } catch {
        // The current owner remains authoritative until activation.
      }
      await this.recover(tokens, acceptedByFailedCandidate);
      return { kind: "retained", reason: "activation-failed" };
    } finally {
      await Promise.all(markers.map((marker) => disposeHook(marker)));
    }
  }

  /** After a transfer, the original run parks until the final owner reports the session result. */
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

  /** Starts the candidate and waits for it to activate or fail. */
  private async startAndActivate(
    checkpoint: SessionCheckpoint,
    delivery: DeliverHookPayload,
    targetDeploymentId: string,
  ): Promise<SessionOwnerActivation> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${getWorkflowMetadata().workflowRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      await startSessionOwnerStep({
        activationToken: activation.token,
        anchorRunId: this.input.sessionId,
        checkpoint,
        delivery,
        targetDeploymentId,
      });
      return await activation;
    } finally {
      await disposeHook(activation);
    }
  }

  /** Reclaims the exact hook set and replays payloads accepted while it was released. */
  private async recover(
    tokens: readonly string[],
    payloads: readonly SessionInboxPayload[],
  ): Promise<void> {
    await this.input.inbox.claimSessionHooks(tokens);
    this.input.inbox.restore(payloads);
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
