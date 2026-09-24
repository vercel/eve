import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
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
import { transferReleasedSession } from "#execution/session/legacy-handoff.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an incompatible successor rejects the handoff instead of misreading state.
 * Dynamic skill manifests retain instruction bodies and package revisions.
 */
export const SESSION_CHECKPOINT_VERSION = 8;

/** Everything a successor needs to continue an idle session. Hooks are derived from the state. */
export interface SessionCheckpoint {
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly capabilities?: SessionCapabilities;
  readonly mode: RunMode;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutMs: number | false;
}

/**
 * How an owner moves its hooks to a successor, fixed by the Workflow spec its
 * run was started on. `takeover`: the successor force-claims them while this
 * owner still holds them, so the session is never unowned. `release`: the run
 * predates forced claims and cannot be taken from, so it releases them first.
 */
export type SessionHandoffProtocol = "takeover" | "release";

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
      /** Tokens the successor claimed and released again; absent before takeover handoffs. */
      readonly releasedTokens?: readonly string[];
    };

export type SessionTransferOutcome =
  | { readonly kind: "transferred" }
  | {
      readonly kind: "retained";
      readonly reason:
        | "same-deployment"
        | "missing-deployment"
        | "not-idle"
        | "busy"
        | "accepted-during-release"
        | "activation-failed";
    };

/** One attempt to start a successor on the triggering delivery's deployment. */
export interface SessionCandidate {
  readonly checkpoint: SessionCheckpoint;
  readonly delivery: DeliverHookPayload;
  readonly targetDeploymentId: string;
  /** The exact hook set the successor claims, derived from the checkpoint. */
  readonly tokens: readonly string[];
}

export interface SessionHandoffInput {
  readonly checkpoint: Omit<SessionCheckpoint, "serializedContext" | "sessionState" | "version">;
  readonly deploymentId: string;
  readonly inbox: SessionInboxHandle;
  readonly isInitialOwner: boolean;
  readonly protocol: SessionHandoffProtocol;
  readonly sessionId: string;
}

export function sessionAnchorToken(sessionId: string): string {
  return `${sessionId}:anchor`;
}

/**
 * The sole boundary for moving an idle session to another exact deployment.
 * Constructed once per owner; `tryTransfer()` is attempted per eligible selection.
 */
export class SessionHandoff {
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

    const candidate: SessionCandidate = {
      checkpoint: { ...this.input.checkpoint, ...state, version: SESSION_CHECKPOINT_VERSION },
      delivery: selection.delivery,
      targetDeploymentId,
      tokens: sessionHookTokens(state),
    };
    await this.ensureAnchor();
    if (this.input.protocol === "release") {
      return await transferReleasedSession(candidate, inbox, () =>
        this.startAndActivate(candidate),
      );
    }
    return await this.transferByTakeover(candidate);
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

  /** Keeps every hook while the successor force-claims them in place. */
  private async transferByTakeover(candidate: SessionCandidate): Promise<SessionTransferOutcome> {
    const { inbox, sessionId } = this.input;
    // A backlog is never transferred to salvage a handoff.
    if (inbox.hasPending()) return { kind: "retained", reason: "busy" };
    const activation = await this.startAndActivate(candidate).catch(
      (error: unknown): SessionOwnerActivation => ({ error, kind: "failed", payloads: [] }),
    );
    if (activation.kind === "active") {
      // The takeover ended every reader after it delivered what its hook had
      // accepted, so this is exactly what arrived before the successor owned
      // the session. It trails anything already sent to the successor directly.
      const accepted = await inbox.dispose();
      if (accepted.length > 0) {
        // The successor owns the session now; failing here must not end it.
        await forwardSessionInputStep({ payloads: accepted, sessionId }).catch(() => {});
      }
      return { kind: "transferred" };
    }
    // What the failed candidate accepted arrived after everything still queued here.
    inbox.restore([...inbox.drain(), ...activation.payloads]);
    await inbox.takeSessionHooks(activation.releasedTokens ?? []);
    return { kind: "retained", reason: "activation-failed" };
  }

  /** Starts the candidate and waits for it to activate or fail. */
  private async startAndActivate(candidate: SessionCandidate): Promise<SessionOwnerActivation> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${getWorkflowMetadata().workflowRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      await startSessionOwnerStep({
        activationToken: activation.token,
        anchorRunId: this.input.sessionId,
        checkpoint: candidate.checkpoint,
        delivery: candidate.delivery,
        targetDeploymentId: candidate.targetDeploymentId,
      });
      return await activation;
    } finally {
      await disposeHook(activation);
    }
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
 * Force-claims every session hook for a successor whose source supports
 * forced claims. The source may still hold them; the takeover is atomic per
 * token, so the session never goes unowned. Returns false when a duplicate
 * start of this same attempt won the fence and will report to the source.
 */
export async function takeOverSession(
  input: HandoffWorkflowEntryInput,
  inbox: Pick<SessionInboxHandle, "takeSessionHooks">,
  tokens: readonly string[],
): Promise<boolean> {
  // Forced claims cannot tell two starts of one attempt apart, so a plain
  // claim fences them first. The source's activation token plus its trigger
  // is unique per attempt, and validation runs alongside at no extra latency.
  const fence = createHook<never>({
    token: `${input.activationToken}:${input.delivery.deliveryMetadata?.[0]?.deliveryId ?? ""}`,
  });
  const [validation, fenced] = await Promise.allSettled([
    validateSessionCheckpointStep({ checkpoint: input.checkpoint }),
    claimHookOwnership(fence),
  ]);
  if (fenced.status === "rejected") {
    if (isHookConflictError(fenced.reason)) return false;
    throw fenced.reason;
  }
  if (validation.status === "rejected") throw validation.reason;
  await inbox.takeSessionHooks(tokens);
  return true;
}
