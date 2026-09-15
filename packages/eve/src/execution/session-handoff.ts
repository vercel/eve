import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";
import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/accepted-delivery-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import type { SessionInputQueue, TurnSelection } from "#execution/session-input-queue.js";
import { isSessionIdleForHandoffStep } from "#execution/session-handoff-eligibility-step.js";
import {
  claimSessionHooks,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import type { SessionHookClaims } from "#execution/session-hook-claims.js";
import { startSessionOwnerStep } from "#execution/workflow-runtime.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";

export interface SessionOwnership {
  /** Original Workflow run that owns the public output stream. */
  readonly anchorRunId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
  readonly deploymentId: string;
}

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an incompatible successor rejects the handoff instead of misreading state.
 */
export const SESSION_CHECKPOINT_VERSION = 2;

export interface SessionCheckpoint {
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly anchorToken: string;
  readonly capabilities?: SessionCapabilities;
  readonly hooks: SessionHookClaims;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
}

type SessionHandoffCheckpoint =
  | {
      readonly kind: "ready";
      readonly checkpoint: SessionCheckpoint;
      readonly trigger: SessionHandoffTrigger;
      readonly targetDeploymentId: string;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "same-deployment" | "missing-deployment" | "aliases" | "not-idle" | "busy";
    };

interface SessionHandoffCandidate {
  readonly activation: Hook<SessionOwnerActivation>;
}

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

/** Settled session facts the owner supplies when it considers a handoff. */
/** The owner's committed state plus whatever input it still holds. */
export interface SessionHandoffSnapshot {
  readonly queue: Pick<SessionInputQueue, "pendingCount">;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export interface SessionHandoffTrigger {
  readonly delivery: DeliverHookPayload;
}

export type SessionTransferOutcome =
  | { readonly kind: "transferred" }
  | {
      readonly kind: "retained";
      readonly reason:
        | Extract<SessionHandoffCheckpoint, { readonly kind: "skipped" }>["reason"]
        | "accepted-during-release"
        | "activation-failed";
    };

/**
 * The sole boundary for moving an idle session to another exact deployment.
 * Constructed once per owner; `tryTransfer()` is attempted per eligible selection.
 * When the upstream atomic hook-handoff primitive lands, only this class changes.
 */
export interface SessionHandoffInput {
  readonly anchorToken: string;
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionInboxHandle;
  readonly isInitialOwner: boolean;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionTimeoutDeadline?: Date;
}

export class SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;
  private releasedHookClaims: SessionHookClaims | undefined;

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
    snapshot: SessionHandoffSnapshot,
  ): Promise<SessionTransferOutcome> {
    const staged = await this.checkpoint(selection, snapshot);
    if (staged.kind === "skipped") return { kind: "retained", reason: staged.reason };

    await this.ensureAnchor();
    const acceptedDuringRelease = await this.release();
    if (acceptedDuringRelease.length > 0) {
      await this.recover(acceptedDuringRelease);
      return { kind: "retained", reason: "accepted-during-release" };
    }
    let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
    try {
      const activation = await this.activate(await this.start(staged));
      if (activation.kind === "active") return { kind: "transferred" };
      acceptedByFailedCandidate = activation.payloads;
    } catch {
      // The current owner remains authoritative until activation.
    }
    await this.recover(acceptedByFailedCandidate);
    return { kind: "retained", reason: "activation-failed" };
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

  private async checkpoint(
    selection: TurnSelection,
    snapshot: SessionHandoffSnapshot,
  ): Promise<SessionHandoffCheckpoint> {
    const { commandInbox, mode, ownership } = this.input;
    const { delivery, provenance } = selection;
    const targetDeploymentId = readAcceptedDeploymentId(delivery);
    if (targetDeploymentId === undefined) return { kind: "skipped", reason: "missing-deployment" };
    if (targetDeploymentId === ownership.deploymentId) {
      return { kind: "skipped", reason: "same-deployment" };
    }
    // Until Workflow supports atomic forced claims, releasing an alias lets a
    // concurrent channel delivery create a replacement session in the gap.
    if (commandInbox.hookClaims.aliases.length > 0) {
      return { kind: "skipped", reason: "aliases" };
    }
    // Only a lone, callerless conversational message with nothing else queued
    // or in flight may move the session; anything else is work for this owner.
    if (
      mode !== "conversation" ||
      provenance.source !== "conversation" ||
      provenance.admissions.length !== 1 ||
      delivery.caller !== undefined ||
      snapshot.queue.pendingCount > 0 ||
      commandInbox.hasPending()
    ) {
      return { kind: "skipped", reason: "busy" };
    }
    if (!(await isSessionIdleForHandoffStep({ sessionState: snapshot.sessionState }))) {
      return { kind: "skipped", reason: "not-idle" };
    }
    return {
      checkpoint: {
        anchorToken: this.input.anchorToken,
        capabilities: this.input.capabilities,
        hooks: commandInbox.hookClaims,
        mode,
        ownership,
        retention: this.input.retention,
        serializedContext: snapshot.serializedContext,
        sessionState: snapshot.sessionState,
        sessionTimeoutDeadline: this.input.sessionTimeoutDeadline,
        version: SESSION_CHECKPOINT_VERSION,
      },
      kind: "ready",
      targetDeploymentId,
      trigger: { delivery },
    };
  }

  /** Releases every session hook, remembering the exact set so `recover` can reclaim it. */
  private async release(): Promise<readonly SessionInboxPayload[]> {
    this.releasedHookClaims = this.input.commandInbox.hookClaims;
    return await this.input.commandInbox.release();
  }

  private async start(
    ready: Extract<SessionHandoffCheckpoint, { readonly kind: "ready" }>,
  ): Promise<SessionHandoffCandidate> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${this.input.ownership.ownerRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      await startSessionOwnerStep({
        activationToken: activation.token,
        checkpoint: ready.checkpoint,
        trigger: ready.trigger,
        targetDeploymentId: ready.targetDeploymentId,
      });
      return { activation };
    } catch (error) {
      await disposeHook(activation);
      throw error;
    }
  }

  private async activate(candidate: SessionHandoffCandidate): Promise<SessionOwnerActivation> {
    try {
      return await candidate.activation;
    } finally {
      await disposeHook(candidate.activation);
    }
  }

  /** Reclaims the exact hook set and replays payloads accepted while it was released. */
  private async recover(payloads: readonly SessionInboxPayload[]): Promise<void> {
    const { commandInbox } = this.input;
    if (this.releasedHookClaims === undefined) {
      throw new Error("Cannot recover session hooks before releasing ownership.");
    }
    await claimSessionHooks(commandInbox, this.releasedHookClaims);
    commandInbox.restore(payloads);
  }

  private async ensureAnchor(): Promise<void> {
    // Only the original run outlives successors; intermediate owners exit.
    if (!this.input.isInitialOwner || this.anchor !== undefined) return;
    this.anchor = createHook<WorkflowEntryResult>({ token: this.input.anchorToken });
    await claimHookOwnership(this.anchor);
  }
}
