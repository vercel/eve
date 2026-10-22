import {
  createHook,
  getWorkflowMetadata,
  sleep,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import type { SessionCapabilities } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type {
  SessionHandoverPayload,
  SessionInboxHandle,
  SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionHandoffStart, WorkflowEntryResult } from "#execution/session/entry-input.js";
import {
  hasRunEndedStep,
  reportHandoverPartStuckStep,
  reportSessionHandoffRetainedStep,
  reportSessionTakenOverOutsideAttemptStep,
  sendSessionHandoverPartStep,
  startSuccessorStep,
} from "#execution/session/handoff-steps.js";
import {
  abandonHandoverIfRunEnds,
  watchRunEnd,
  type RunWatch,
} from "#execution/session/run-watch.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-state.js";
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
export const SESSION_CHECKPOINT_VERSION = 17;

/** Everything a successor needs to continue an idle session. Hooks are derived from the state. */
export interface SessionCheckpoint {
  readonly admittedDeliveryKeys: readonly string[];
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
      /** Version 3: the successor run that gave this verdict. */
      readonly runId?: string;
      /** Commands accepted by partial successor claims before it rejected the checkpoint. */
      readonly payloads: readonly SessionInboxPayload[];
    }
  | {
      readonly kind: "failed";
      /**
       * Version 3: the successor took some of the session's hooks before it
       * failed. The owner takes them back and waits for their handover.
       */
      readonly claimedHooks?: boolean;
      readonly error: unknown;
      /** Version 3: the successor run that gave this verdict. */
      readonly runId?: string;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

interface SessionHandoffInput {
  readonly checkpoint: Omit<
    SessionCheckpoint,
    "admittedDeliveryKeys" | "history" | "serializedContext" | "sessionState" | "version"
  >;
  readonly deploymentId: string;
  readonly inbox: SessionInboxHandle;
  readonly isInitialOwner: boolean;
  readonly sessionId: string;
}

export function sessionAnchorToken(sessionId: string): string {
  return `${sessionId}:anchor`;
}

/** Only one run per attempt can hold this; a successor that loses it exits untouched. */
export function handoffLeaseToken(attemptKey: string): string {
  return `eve:handoff:lease:${attemptKey}`;
}

/**
 * Measured from the lease's creation and far beyond any queue delay, so a
 * duplicate candidate that boots late still finds the token taken.
 */
export const HANDOFF_LEASE_RETENTION = "7d";

type SessionTransferOutcome =
  | { readonly kind: "transferred" }
  | { readonly kind: "retained"; readonly reason: SessionRetainedReason };

type SessionRetainedReason =
  | "same-deployment"
  | "missing-deployment"
  | "not-idle"
  | "busy"
  | "activation-failed"
  | "checkpoint-incompatible"
  | "known-incompatible"
  | "unsupported-world";

type SessionTransferState = Pick<
  SessionCheckpoint,
  "admittedDeliveryKeys" | "history" | "serializedContext" | "sessionState"
>;

type AttemptSettlement =
  | { readonly kind: "taken-over" }
  | { readonly kind: "candidate-ended" }
  | { readonly kind: "arrival" }
  | { readonly kind: "deadline" }
  | { readonly kind: "verdict"; readonly verdict: SessionOwnerActivation };

/** Who holds an attempt's lease once the owner has tried to claim it. */
type AttemptFence =
  /** The owner: no candidate can take over any more. */
  | { readonly kind: "won" }
  /** A candidate that gave its verdict or has ended. */
  | { readonly kind: "done"; readonly runId: string }
  /** A live candidate that may still take over. */
  | { readonly kind: "live"; readonly runId: string };

/** The successor run that gave a verdict, if the outcome is one. */
function verdictRunId(settled: AttemptSettlement): string | undefined {
  return settled.kind === "verdict" && settled.verdict.kind !== "active"
    ? settled.verdict.runId
    : undefined;
}

/**
 * How long a candidate may stay silent, once input is waiting, before the
 * owner fences the attempt. The timer starts only when input is pending: an
 * open wait turns off Workflow's inline step delta, and a stuck attempt only
 * matters once input is waiting for it.
 */
const HANDOFF_BOOT_DEADLINE_MS = 5 * 60_000;

/**
 * Sends `payloads` as handover parts, one payload per part: each was accepted
 * on its own, so no part exceeds what the World already took. Every part is
 * retried with backoff until it is delivered or the session has ended: the
 * receiver reads nothing until the final part lands, and dropping a part
 * would lose a message the session accepted.
 */
export async function sendSessionHandover(input: {
  readonly attemptKey: string;
  readonly payloads: readonly SessionInboxPayload[];
  readonly sessionId: string;
}): Promise<void> {
  const { attemptKey, sessionId } = input;
  // A handover is consumed on arrival and never queued, so none is ever drained.
  const payloads = input.payloads.filter(
    (payload): payload is SessionHandoverPayload["payloads"][number] => payload.kind !== "handover",
  );
  for (const [index, payload] of payloads.entries()) {
    const sent = await sendHandoverPart({ attemptKey, index, payloads: [payload] }, sessionId);
    if (sent === "session-ended") return;
  }
  await sendHandoverPart(
    { attemptKey, final: true, index: payloads.length, payloads: [] },
    sessionId,
  );
}

async function sendHandoverPart(
  part: Omit<SessionHandoverPayload, "kind">,
  sessionId: string,
): Promise<"delivered" | "session-ended"> {
  for (let failures = 1, delaySeconds = 1; ; failures++) {
    try {
      return await sendSessionHandoverPartStep({ part, sessionId });
    } catch (error) {
      if (failures === HANDOVER_PART_FAILURES_BEFORE_REPORT) {
        await reportHandoverPartStuckStep({
          attemptKey: part.attemptKey,
          error: isObject(error) && typeof error.message === "string" ? error.message : undefined,
          failures,
          index: part.index,
          sessionId,
        }).catch(() => {});
      }
      await sleep(delaySeconds * 1000);
      delaySeconds = Math.min(delaySeconds * 2, 60);
    }
  }
}

/** Each failure is a send step that already exhausted its own retries. */
const HANDOVER_PART_FAILURES_BEFORE_REPORT = 5;

type RetainedAttempt = {
  readonly error?: unknown;
  readonly reason: "activation-failed" | "checkpoint-incompatible";
};

/**
 * The sole boundary for moving an idle session to a successor run: on another
 * exact deployment when newer code accepts a delivery, or on this deployment
 * after compaction so no single run's event log grows with the session.
 * Constructed once per owner; each `try*` method attempts one transfer.
 *
 * The owner never releases its hooks. The successor force-claims every one of
 * them, and the takeover itself is the success signal: the owner then hands
 * over whatever it accepted meanwhile and exits. Until the attempt settles
 * the owner runs no turn.
 */
export class SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;
  /** Deployments that rejected this session's checkpoint during this owner run. */
  private readonly incompatibleTargetDeploymentIds = new Set<string>();
  /** Counts this run's attempts; replay repeats the same sequence. */
  private attempts = 0;
  /** The World cannot force-claim hooks, so no attempt can ever succeed. */
  private worldUnsupported = false;

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

  /**
   * Attempts to move the session to the selected delivery's deployment. The
   * outcome states whether the successor took over or this owner retained the
   * session. Candidate failures recover locally rather than escaping.
   */
  async tryTransfer(
    selection: TurnSelection,
    state: SessionTransferState,
  ): Promise<SessionTransferOutcome> {
    const { delivery } = selection;
    const targetDeploymentId = readAcceptedDeploymentId(delivery);
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
   * deployment. The caller guarantees no input is waiting; the successor
   * parks until the next one arrives.
   */
  async tryCompactionTransfer(state: SessionTransferState): Promise<SessionTransferOutcome> {
    const { deploymentId } = this.input;
    if (this.incompatibleTargetDeploymentIds.has(deploymentId))
      return { kind: "retained", reason: "known-incompatible" };
    return await this.transfer(state, deploymentId, { reason: "compaction" });
  }

  async tryPrewarmTransfer(
    state: SessionTransferState,
    targetDeploymentId: string,
    sessionTimeoutDeadline: Date | undefined,
  ): Promise<SessionTransferOutcome> {
    if (targetDeploymentId === this.input.deploymentId)
      return { kind: "retained", reason: "same-deployment" };
    if (this.incompatibleTargetDeploymentIds.has(targetDeploymentId))
      return { kind: "retained", reason: "known-incompatible" };
    return await this.transfer(state, targetDeploymentId, {
      reason: "prewarm",
      sessionTimeoutDeadline,
    });
  }

  private async transfer(
    state: SessionTransferState,
    targetDeploymentId: string,
    start: SessionHandoffStart,
  ): Promise<SessionTransferOutcome> {
    const { inbox } = this.input;
    if (this.worldUnsupported) return { kind: "retained", reason: "unsupported-world" };
    // The previous attempt's payloads have not come back yet.
    if (inbox.awaitingHandover) return { kind: "retained", reason: "busy" };
    if (!isSessionStateIdleForHandoff(state)) return { kind: "retained", reason: "not-idle" };
    const ownerRunId = getWorkflowMetadata().workflowRunId;
    const attempt = this.attempts++;
    const attemptKey = `${ownerRunId}:${String(attempt)}`;
    const hookTokens = inbox.claimedTokens;
    // Both tokens are unique to this run, so neither awaits its registration:
    // they commit with the start step below, which can then run inline.
    const activation = createHook<SessionOwnerActivation>({
      token: `${ownerRunId}:handoff:${String(attempt)}`,
    });
    this.ensureAnchor();
    const attemptEnded = new AbortController();
    // Workflow's clock is replay-stable.
    const startedAt = Date.now();
    try {
      let candidateRunId: string;
      try {
        const started = await startSuccessorStep({
          ...start,
          activationToken: activation.token,
          anchorRunId: this.input.sessionId,
          attemptKey,
          checkpoint: { ...this.input.checkpoint, ...state, version: SESSION_CHECKPOINT_VERSION },
          hookTokens,
          sourceRunId: ownerRunId,
          targetDeploymentId,
        });
        if (started.kind === "not-idle") return { kind: "retained", reason: "not-idle" };
        if (started.kind === "unsupported") {
          this.worldUnsupported = true;
          return { kind: "retained", reason: "unsupported-world" };
        }
        candidateRunId = started.runId;
      } catch (error) {
        // `start()` can create the run and still fail.
        const fence = await this.fenceAttempt(attemptKey);
        if (fence.kind !== "live") {
          if (fence.kind === "done") await this.holdEveryToken(hookTokens);
          await this.reportRetained("activation-failed", targetDeploymentId, error);
          return { kind: "retained", reason: "activation-failed" };
        }
        candidateRunId = fence.runId;
      }
      const takenOver = inbox
        .whenTakenOver(attemptEnded.signal)
        .then((): AttemptSettlement => ({ kind: "taken-over" }));
      // Watching a candidate costs a wait every few seconds, so it starts only
      // once the deadline has fenced the attempt and a live candidate remains.
      let watch: RunWatch | undefined;
      let deadline: Promise<AttemptSettlement> | undefined;
      while (true) {
        if (watch === undefined && deadline === undefined && inbox.hasPending()) {
          const remaining = startedAt + HANDOFF_BOOT_DEADLINE_MS - Date.now();
          deadline = sleep(Math.max(0, remaining)).then(() => ({ kind: "deadline" }));
        }
        let settled: AttemptSettlement;
        try {
          settled = await Promise.race<AttemptSettlement>([
            takenOver,
            activation.then((verdict) => ({ kind: "verdict", verdict })),
            watch !== undefined
              ? watch.ended.then(() => ({ kind: "candidate-ended" }))
              : (deadline ?? inbox.whenArrival().then(() => ({ kind: "arrival" }))),
          ]);
        } finally {
          watch?.stop();
        }
        if (settled.kind === "taken-over") return await this.handOver(attemptKey);
        // Input is now waiting, so the next pass starts the deadline.
        if (settled.kind === "arrival") continue;
        // A duplicate candidate from a retried start step may have given this
        // outcome while the lease winner can still take over.
        // A candidate silent past the deadline may still be booting.
        const gaveUpRunId =
          settled.kind === "candidate-ended" ? candidateRunId : verdictRunId(settled);
        const fence = await this.fenceAttempt(attemptKey, gaveUpRunId);
        if (fence.kind === "live") {
          candidateRunId = fence.runId;
          watch = watchRunEnd(candidateRunId);
          continue;
        }
        // Only a lease holder can have claimed addresses. One that gave a
        // verdict reports what it holds; any other may hold some.
        if (fence.kind === "done" && fence.runId !== verdictRunId(settled))
          await this.holdEveryToken(hookTokens);
        const retained =
          settled.kind === "verdict"
            ? await this.recover(settled.verdict, {
                attemptKey,
                candidateRunId,
                hookTokens,
                targetDeploymentId,
              })
            : this.recoverFromSilentCandidate(settled.kind);
        await this.reportRetained(retained.reason, targetDeploymentId, retained.error);
        return { kind: "retained", reason: retained.reason };
      }
    } finally {
      attemptEnded.abort();
      await disposeHook(activation);
    }
  }

  /**
   * The session was taken over while no attempt was open. This run leaves as
   * after a transfer, without finalizing the stream the new owner now writes.
   */
  async adoptTakeover(): Promise<{ readonly kind: "transferred" }> {
    // Every forced claim happens inside an attempt, so this is a bug; report
    // it, but still leave the stream to whichever run took it.
    await reportSessionTakenOverOutsideAttemptStep({ sessionId: this.input.sessionId });
    // Attempts normally create the anchor; with none open, the original run
    // creates it now so it still parks for the final owner's result.
    this.ensureAnchor();
    return { kind: "transferred" };
  }

  /**
   * Claims the attempt's lease. `gaveUpRunId` is the candidate whose outcome
   * the owner is acting on: holding the lease, it can no longer take over.
   */
  private async fenceAttempt(attemptKey: string, gaveUpRunId?: string): Promise<AttemptFence> {
    const lease = createHook<never>({
      experimental_minRetention: HANDOFF_LEASE_RETENTION,
      token: handoffLeaseToken(attemptKey),
    });
    try {
      await claimHookOwnership(lease);
    } catch (error) {
      if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
      const runId = error.conflictingRunId;
      if (runId === gaveUpRunId || (await hasRunEndedStep({ runId })))
        return { kind: "done", runId };
      return { kind: "live", runId };
    }
    // Held for the rest of this run, like the successor's lease: disposing it
    // would free the token at once for a late candidate. Retention keeps it
    // reserved after the run ends.
    return { kind: "won" };
  }

  /** Forwards what this run accepted but never read to the run that took the session over. */
  private async handOver(attemptKey: string): Promise<{ readonly kind: "transferred" }> {
    await sendSessionHandover({
      attemptKey,
      payloads: this.input.inbox.drain(),
      sessionId: this.input.sessionId,
    });
    return { kind: "transferred" };
  }

  /**
   * Takes back every address a candidate that gave up may hold. Forced claims
   * replace this run's own hooks, so this holds whether or not a pump has
   * observed the candidate's claim yet.
   */
  private async holdEveryToken(hookTokens: readonly string[]): Promise<void> {
    await this.input.inbox.claimSessionHooks(hookTokens, { force: true });
  }

  private recoverFromSilentCandidate(kind: "candidate-ended" | "deadline"): RetainedAttempt {
    const message =
      kind === "deadline"
        ? `The successor run did not report within ${String(HANDOFF_BOOT_DEADLINE_MS / 60_000)} minutes.`
        : "The successor run ended before the handoff settled.";
    return { error: new Error(message), reason: "activation-failed" };
  }

  /** Keeps the session after a candidate's verdict, taking back any hook it claimed. */
  private async recover(
    verdict: SessionOwnerActivation,
    attempt: {
      readonly attemptKey: string;
      readonly candidateRunId: string;
      readonly hookTokens: readonly string[];
      readonly targetDeploymentId: string;
    },
  ): Promise<RetainedAttempt> {
    const { inbox } = this.input;
    switch (verdict.kind) {
      case "active":
        // Only a successor that claims ordinarily signals `active`, and it
        // cannot while this owner holds the hooks.
        return {
          error: new Error("Successor reported active without a takeover."),
          reason: "activation-failed",
        };
      case "incompatible":
        this.incompatibleTargetDeploymentIds.add(attempt.targetDeploymentId);
        if (verdict.payloads.length > 0) inbox.restore(verdict.payloads);
        return { reason: "checkpoint-incompatible" };
      case "failed":
        if (verdict.claimedHooks === true) {
          // If this throws, the session fails here; the successor stops
          // waiting to be taken back once this run ends.
          await inbox.claimSessionHooks(attempt.hookTokens, {
            force: true,
            handover: attempt.attemptKey,
          });
          abandonHandoverIfRunEnds(inbox, {
            attemptKey: attempt.attemptKey,
            sourceRunId: verdict.runId ?? attempt.candidateRunId,
          });
        } else if (isHookConflictError(verdict.error)) {
          // A successor older than this protocol claims ordinarily and so can
          // never take over from an owner that keeps its hooks.
          this.incompatibleTargetDeploymentIds.add(attempt.targetDeploymentId);
        }
        if (verdict.payloads.length > 0) inbox.restore(verdict.payloads);
        return { error: verdict.error, reason: "activation-failed" };
    }
  }

  private ensureAnchor(): void {
    // Only the original run outlives successors; intermediate owners exit.
    if (!this.input.isInitialOwner || this.anchor !== undefined) return;
    this.anchor = createHook<WorkflowEntryResult>({
      token: sessionAnchorToken(this.input.sessionId),
    });
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
}
