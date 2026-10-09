import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionHandoffStart, WorkflowEntryResult } from "#execution/session/entry-input.js";
import { startSessionOwnerStep } from "#execution/workflow-runtime.js";
import { sessionHandoffMarkerToken } from "#execution/session-inbox/address.js";
import {
  isSessionIdleForHandoffStep,
  reportSessionHandoffRetainedStep,
} from "#execution/session/handoff-steps.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import { isObject } from "#shared/guards.js";

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an older successor rejects the handoff instead of misreading state.
 *
 * A newer successor must always accept older checkpoints: every bump adds the
 * upgrade from the previous version in `checkpoint-migrations.ts`.
 */
export const SESSION_CHECKPOINT_VERSION = 14;

/** Everything a successor needs to continue an idle session. Hooks are derived from the state. */
export interface SessionCheckpoint {
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly capabilities?: SessionCapabilities;
  readonly history: HarnessModelMessage[];
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutMs: number | false;
}

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      // Owners running older eve builds read every non-`active` result as a
      // failure, so this variant carries `payloads` in the same shape.
      readonly kind: "incompatible";
      readonly reason: "checkpoint-version";
      /** Commands accepted by partial successor claims before it rejected the checkpoint. */
      readonly payloads: readonly SessionInboxPayload[];
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

interface SessionHandoffInput {
  readonly checkpoint: Omit<
    SessionCheckpoint,
    "history" | "serializedContext" | "sessionState" | "version"
  >;
  readonly deploymentId: string;
  readonly inbox: SessionInboxHandle;
  readonly isInitialOwner: boolean;
  readonly sessionId: string;
}

export function sessionAnchorToken(sessionId: string): string {
  return `${sessionId}:anchor`;
}

type SessionTransferOutcome =
  | { readonly kind: "transferred" }
  | { readonly kind: "retained"; readonly reason: SessionRetainedReason };

type SessionRetainedReason =
  | "same-deployment"
  | "missing-deployment"
  | "not-idle"
  | "busy"
  | "accepted-during-release"
  | "activation-failed"
  | "checkpoint-incompatible"
  | "known-incompatible";

/** A compaction handoff the owner owes; the successor keeps this deadline. */
export interface CompactionHandoff {
  readonly sessionTimeoutDeadline: Date | undefined;
}

type SessionTransferState = Pick<
  SessionCheckpoint,
  "history" | "serializedContext" | "sessionState"
>;

/**
 * The sole boundary for moving an idle session to a successor run: on another
 * exact deployment when newer code accepts a delivery, or on this deployment
 * after compaction so no single run's event log grows with the session.
 * Constructed once per owner; each `try*` method attempts one transfer.
 * When the upstream atomic hook-handoff primitive lands, only this class changes.
 *
 * Skipping known-incompatible targets requires this owner run to execute the
 * `incompatible` activation branch below. Owners still on an older eve build
 * treat that signal as a generic failure and attempt handoff on every turn;
 * they still benefit from successors returning incompatibility without step
 * retries.
 */
export class SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;
  /** Deployments that rejected this session's checkpoint during this owner run. */
  private readonly incompatibleTargetDeploymentIds = new Set<string>();

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  /**
   * Attempts to move the session to the selected delivery's deployment. When a
   * compaction handoff is due and that deployment is this one or unknown, the
   * session moves to a fresh run here instead. The outcome states whether the
   * successor activated or this owner retained the session. Candidate failures
   * recover locally rather than escaping.
   */
  async tryTransfer(
    selection: TurnSelection,
    state: SessionTransferState,
    options: { readonly compaction?: CompactionHandoff } = {},
  ): Promise<SessionTransferOutcome> {
    const { delivery } = selection;
    const targetDeploymentId = readAcceptedDeploymentId(delivery);
    const sameDeployment =
      targetDeploymentId === undefined || targetDeploymentId === this.input.deploymentId;
    if (sameDeployment && options.compaction !== undefined) {
      if (!selection.handoffEligible) return { kind: "retained", reason: "busy" };
      return await this.tryCompactionTransfer(state, { ...options.compaction, delivery });
    }
    if (targetDeploymentId === undefined) return { kind: "retained", reason: "missing-deployment" };
    if (targetDeploymentId === this.input.deploymentId)
      return { kind: "retained", reason: "same-deployment" };
    if (this.incompatibleTargetDeploymentIds.has(targetDeploymentId))
      return { kind: "retained", reason: "known-incompatible" };
    if (!selection.handoffEligible) return { kind: "retained", reason: "busy" };
    return await this.transfer(state, targetDeploymentId, { delivery });
  }

  /**
   * Attempts to move a session that compacted to a fresh run on this
   * deployment. Without a delivery the caller guarantees no input is waiting,
   * and the successor parks until the next one arrives. The successor keeps
   * the session's deadline.
   */
  async tryCompactionTransfer(
    state: SessionTransferState,
    compaction: CompactionHandoff & { readonly delivery?: DeliverHookPayload },
  ): Promise<SessionTransferOutcome> {
    const { deploymentId } = this.input;
    if (this.incompatibleTargetDeploymentIds.has(deploymentId))
      return { kind: "retained", reason: "known-incompatible" };
    return await this.transfer(state, deploymentId, { ...compaction, reason: "compaction" });
  }

  private async transfer(
    state: SessionTransferState,
    targetDeploymentId: string,
    start: SessionHandoffStart,
  ): Promise<SessionTransferOutcome> {
    const { inbox } = this.input;
    if (!(await isSessionIdleForHandoffStep({ sessionState: state.sessionState })))
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
    let retained: {
      readonly error?: unknown;
      readonly reason: "activation-failed" | "checkpoint-incompatible";
    };
    try {
      const acceptedDuringRelease = await inbox.release();
      if (acceptedDuringRelease.length > 0) {
        await this.recover(tokens, acceptedDuringRelease);
        return { kind: "retained", reason: "accepted-during-release" };
      }
      let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
      try {
        const activation = await this.startAndActivate(checkpoint, start, targetDeploymentId);
        if (activation.kind === "active") return { kind: "transferred" };
        acceptedByFailedCandidate = activation.payloads;
        if (activation.kind === "incompatible") {
          this.incompatibleTargetDeploymentIds.add(targetDeploymentId);
          retained = { reason: "checkpoint-incompatible" };
        } else {
          retained = { error: activation.error, reason: "activation-failed" };
        }
      } catch (error) {
        // The current owner remains authoritative until activation.
        retained = { error, reason: "activation-failed" };
      }
      await this.recover(tokens, acceptedByFailedCandidate);
    } finally {
      await Promise.all(markers.map((marker) => disposeHook(marker)));
    }
    await this.reportRetained(retained.reason, targetDeploymentId, retained.error);
    return { kind: "retained", reason: retained.reason };
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
    start: SessionHandoffStart,
    targetDeploymentId: string,
  ): Promise<SessionOwnerActivation> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${getWorkflowMetadata().workflowRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      await startSessionOwnerStep({
        ...start,
        activationToken: activation.token,
        anchorRunId: this.input.sessionId,
        checkpoint,
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

  private async reportRetained(
    reason: "activation-failed" | "checkpoint-incompatible",
    targetDeploymentId: string,
    error?: unknown,
  ): Promise<void> {
    const message =
      isObject(error) && typeof error.message === "string" ? error.message : undefined;
    await reportSessionHandoffRetainedStep({
      error: message,
      reason,
      sessionId: this.input.sessionId,
      sourceDeploymentId: this.input.deploymentId,
      targetDeploymentId,
    });
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
