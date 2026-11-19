import {
  createHook,
  getWorkflowMetadata,
  sleep,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import { readAcceptedDeploymentId } from "#execution/session/accepted-deployment.js";
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
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionTransferState,
} from "#execution/session/checkpoint.js";
import { isObject } from "#shared/guards.js";

export type SessionOwnerActivation =
  | {
      readonly kind: "incompatible";
      readonly reason: "checkpoint-version";
      readonly runId?: string;
      readonly payloads: readonly SessionInboxPayload[];
    }
  | {
      readonly kind: "failed";
      readonly claimedHooks?: boolean;
      readonly error: unknown;
      readonly runId?: string;
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
  readonly sessionWritable: WritableStream<Uint8Array>;
}

export function sessionAnchorToken(sessionId: string): string {
  return `${sessionId}:anchor`;
}

export function handoffLeaseToken(attemptKey: string): string {
  return `eve:handoff:lease:${attemptKey}`;
}

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

type AttemptSettlement =
  | { readonly kind: "taken-over" }
  | { readonly kind: "candidate-ended" }
  | { readonly kind: "arrival" }
  | { readonly kind: "deadline" }
  | { readonly kind: "verdict"; readonly verdict: SessionOwnerActivation };

type AttemptFence =
  | { readonly kind: "won" }
  | { readonly kind: "done"; readonly runId: string }
  | { readonly kind: "live"; readonly runId: string };

function verdictRunId(settled: AttemptSettlement): string | undefined {
  return settled.kind === "verdict" ? settled.verdict.runId : undefined;
}

const HANDOFF_BOOT_DEADLINE_MS = 5 * 60_000;

export async function sendSessionHandover(input: {
  readonly attemptKey: string;
  readonly payloads: readonly SessionInboxPayload[];
  readonly sessionId: string;
}): Promise<void> {
  const { attemptKey, sessionId } = input;
  const payloads = input.payloads.filter(
    (payload): payload is SessionHandoverPayload["payloads"][number] => payload.kind !== "handover",
  );
  for (const [index, payload] of payloads.entries()) {
    const sent = await sendHandoverPart(
      { attemptKey, index, payloads: [payload] },
      sessionId,
      payloads.length,
    );
    if (sent === "session-ended") return;
  }
  await sendHandoverPart(
    { attemptKey, final: true, index: payloads.length, payloads: [] },
    sessionId,
    payloads.length,
  );
}

async function sendHandoverPart(
  part: Omit<SessionHandoverPayload, "kind">,
  sessionId: string,
  bufferedPayloadCount: number,
): Promise<"delivered" | "session-ended"> {
  for (let failures = 1, delaySeconds = 1; ; failures++) {
    try {
      return await sendSessionHandoverPartStep({ bufferedPayloadCount, part, sessionId });
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

const HANDOVER_PART_FAILURES_BEFORE_REPORT = 5;

type RetainedAttempt = {
  readonly error?: unknown;
  readonly reason: "activation-failed" | "checkpoint-incompatible";
};

export class SessionHandoff {
  private readonly input: SessionHandoffInput;
  private anchor: Hook<WorkflowEntryResult> | undefined;
  private readonly incompatibleTargetDeploymentIds = new Set<string>();
  private attempts = 0;
  private worldUnsupported = false;

  constructor(input: SessionHandoffInput) {
    this.input = input;
  }

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
    if (inbox.awaitingHandover) return { kind: "retained", reason: "busy" };
    if (!isSessionStateIdleForHandoff(state)) return { kind: "retained", reason: "not-idle" };
    const ownerRunId = getWorkflowMetadata().workflowRunId;
    const attempt = this.attempts++;
    const attemptKey = `${ownerRunId}:${String(attempt)}`;
    const hookTokens = inbox.claimedTokens;
    const activation = createHook<SessionOwnerActivation>({
      token: `${ownerRunId}:handoff:${String(attempt)}`,
    });
    this.ensureAnchor();
    const attemptEnded = new AbortController();
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
          sessionWritable: this.input.sessionWritable,
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
        if (settled.kind === "arrival") continue;
        const gaveUpRunId =
          settled.kind === "candidate-ended" ? candidateRunId : verdictRunId(settled);
        const fence = await this.fenceAttempt(attemptKey, gaveUpRunId);
        if (fence.kind === "live") {
          candidateRunId = fence.runId;
          watch = watchRunEnd(candidateRunId);
          continue;
        }
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

  async adoptTakeover(): Promise<{ readonly kind: "transferred" }> {
    await reportSessionTakenOverOutsideAttemptStep({ sessionId: this.input.sessionId });
    this.ensureAnchor();
    return { kind: "transferred" };
  }

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
    return { kind: "won" };
  }

  private async handOver(attemptKey: string): Promise<{ readonly kind: "transferred" }> {
    await sendSessionHandover({
      attemptKey,
      payloads: this.input.inbox.drain(),
      sessionId: this.input.sessionId,
    });
    return { kind: "transferred" };
  }

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
      case "incompatible":
        this.incompatibleTargetDeploymentIds.add(attempt.targetDeploymentId);
        if (verdict.payloads.length > 0) inbox.restore(verdict.payloads);
        return { reason: "checkpoint-incompatible" };
      case "failed":
        if (verdict.claimedHooks === true) {
          await inbox.claimSessionHooks(attempt.hookTokens, {
            force: true,
            handover: attempt.attemptKey,
          });
          abandonHandoverIfRunEnds(inbox, {
            attemptKey: attempt.attemptKey,
            sourceRunId: verdict.runId ?? attempt.candidateRunId,
          });
        }
        if (verdict.payloads.length > 0) inbox.restore(verdict.payloads);
        return { error: verdict.error, reason: "activation-failed" };
    }
  }

  private ensureAnchor(): void {
    if (!this.input.isInitialOwner || this.anchor !== undefined) return;
    this.anchor = createHook<WorkflowEntryResult>({
      token: sessionAnchorToken(this.input.sessionId),
    });
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
