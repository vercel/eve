import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/accepted-delivery-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import type { SessionBacklog } from "#execution/session-backlog.js";
import { isSessionIdleForHandoffStep } from "#execution/session-handoff-eligibility-step.js";
import {
  claimSessionHooks,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
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

/** Complete hook set a successor must claim before it can own the session. */
export interface SessionHookClaims {
  /** The stable session inbox followed by every additive continuation address. */
  readonly session: readonly string[];
}

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an incompatible successor rejects the handoff instead of misreading state.
 */
export const SESSION_CHECKPOINT_VERSION = 1;

export interface SessionCheckpoint {
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly anchorToken: string;
  readonly caller?: TurnCaller;
  readonly capabilities?: SessionCapabilities;
  readonly hooks: SessionHookClaims;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
}

export type SessionHandoffCheckpoint =
  | {
      readonly kind: "ready";
      readonly checkpoint: SessionCheckpoint;
      readonly delivery: DeliverHookPayload;
      readonly targetDeploymentId: string;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "same-deployment" | "missing-deployment" | "not-idle" | "busy";
    };

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

/** Settled session facts the owner supplies when it considers a handoff. */
export interface SessionHandoffSnapshot {
  readonly caller?: TurnCaller;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * The sole boundary for moving an idle session to another exact deployment.
 * Constructed once per owner; `transfer()` is attempted per eligible delivery.
 * When the upstream atomic hook-handoff primitive lands, only this class changes.
 */
export interface SessionHandoffInput {
  readonly anchorToken: string;
  readonly backlog: SessionBacklog;
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
  private anchor: Hook<{ readonly output: unknown }> | undefined;
  private releasedHookTokens: readonly string[] = [];

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  /**
   * Attempts to move the session to the delivery's deployment. Returns `true`
   * once a successor has activated; otherwise this owner keeps the session and
   * must process the delivery itself. Never throws for a failed candidate.
   */
  async transfer(delivery: DeliverHookPayload, snapshot: SessionHandoffSnapshot): Promise<boolean> {
    const staged = await this.checkpoint(delivery, snapshot);
    if (staged.kind === "skipped") return false;

    await this.ensureAnchor();
    const acceptedDuringRelease = await this.release();
    if (acceptedDuringRelease.length > 0) {
      await this.recover(acceptedDuringRelease);
      return false;
    }
    let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
    try {
      const activation = await this.activate(await this.start(staged));
      if (activation.kind === "active") return true;
      acceptedByFailedCandidate = activation.payloads;
    } catch {
      // The current owner remains authoritative until activation.
    }
    await this.recover(acceptedByFailedCandidate);
    return false;
  }

  /** After a transfer, the original run parks until the final owner reports the session result. */
  async awaitAnchoredResult(): Promise<{ readonly output: unknown }> {
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

  async checkpoint(
    delivery: DeliverHookPayload,
    snapshot: SessionHandoffSnapshot,
  ): Promise<SessionHandoffCheckpoint> {
    const { backlog, commandInbox, mode, ownership } = this.input;
    const targetDeploymentId = readAcceptedDeploymentId(delivery);
    if (targetDeploymentId === undefined) return { kind: "skipped", reason: "missing-deployment" };
    if (targetDeploymentId === ownership.deploymentId) {
      return { kind: "skipped", reason: "same-deployment" };
    }
    if (mode !== "conversation" || !backlog.isEmpty() || commandInbox.hasPending()) {
      return { kind: "skipped", reason: "busy" };
    }
    if (!(await isSessionIdleForHandoffStep({ sessionState: snapshot.sessionState }))) {
      return { kind: "skipped", reason: "not-idle" };
    }
    return {
      checkpoint: {
        anchorToken: this.input.anchorToken,
        caller: snapshot.caller,
        capabilities: this.input.capabilities,
        hooks: { session: [...commandInbox.sessionHookTokens] },
        mode,
        ownership,
        retention: this.input.retention,
        serializedContext: snapshot.serializedContext,
        sessionState: snapshot.sessionState,
        sessionTimeoutDeadline: this.input.sessionTimeoutDeadline,
        version: SESSION_CHECKPOINT_VERSION,
      },
      delivery,
      kind: "ready",
      targetDeploymentId,
    };
  }

  /** Releases every session hook, remembering the exact set so `recover` can reclaim it. */
  async release(): Promise<readonly SessionInboxPayload[]> {
    this.releasedHookTokens = [...this.input.commandInbox.sessionHookTokens];
    return await this.input.commandInbox.release();
  }

  async start(
    ready: Extract<SessionHandoffCheckpoint, { readonly kind: "ready" }>,
  ): Promise<SessionHandoffCandidate> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${this.input.ownership.ownerRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      const started = await startSessionOwnerStep({
        activationToken: activation.token,
        checkpoint: ready.checkpoint,
        delivery: ready.delivery,
        targetDeploymentId: ready.targetDeploymentId,
      });
      return { activation, runId: started.runId };
    } catch (error) {
      await disposeHook(activation);
      throw error;
    }
  }

  async activate(candidate: SessionHandoffCandidate): Promise<SessionOwnerActivation> {
    try {
      return await candidate.activation;
    } finally {
      await disposeHook(candidate.activation);
    }
  }

  /** Reclaims the exact hook set and replays payloads accepted while it was released. */
  async recover(payloads: readonly SessionInboxPayload[]): Promise<void> {
    const { commandInbox } = this.input;
    await claimSessionHooks(commandInbox, this.releasedHookTokens);
    commandInbox.restore(payloads);
  }

  private async ensureAnchor(): Promise<void> {
    // Only the original run outlives successors; intermediate owners exit.
    if (!this.input.isInitialOwner || this.anchor !== undefined) return;
    this.anchor = createHook<{ readonly output: unknown }>({ token: this.input.anchorToken });
    await claimHookOwnership(this.anchor);
  }
}

export interface SessionHandoffCandidate {
  readonly activation: Hook<SessionOwnerActivation>;
  readonly runId: string;
}
