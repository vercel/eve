import { activeTurnToken } from "#execution/turn/address.js";
import { getWorkflowMetadata, sleep } from "#compiled/@workflow/core/index.js";
import { createOwnerInbox } from "#execution/inbox/owner.js";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import { awaitTurnStep, forwardSubmissionStep } from "#execution/turn/admission.js";
import { awaitRunStep } from "#internal/workflow/await-run.js";
import { executeTurnStep } from "#execution/turn/execute.js";
import { failTurnStep, finalizeTurnStep } from "#execution/turn/finalize.js";
import {
  interruptionKind,
  reduceTurnBoundary,
  submissionFromEnvelope,
} from "#execution/turn/reduce.js";
import type { TurnExecutionResult, TurnReceipt, TurnWorkflowInput } from "#execution/turn/types.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { SnapshotRecordRef } from "#execution/session/resources.js";
import { deferTurnStep } from "#execution/session/dispatch.js";

export async function turnWorkflow(input: TurnWorkflowInput): Promise<TurnReceipt> {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  const token = activeTurnToken(input.session.sessionId);
  let checkpoint: SnapshotRecordRef | undefined;
  if (input.afterRunId !== undefined) await awaitTurnStep(input.afterRunId);
  while (true) {
    const inbox = createOwnerInbox({ token });
    try {
      const claim = await inbox.claim();
      if (claim.kind === "owned") {
        const eventIds = new Set([input.submission.eventId]);
        let result: Exclude<TurnExecutionResult, { kind: "progress" }>;
        try {
          result = await executeClaimedTurn(input, inbox, eventIds, (ref) => {
            checkpoint = ref;
          });
        } catch (error) {
          return await failTurnStep({
            session: input.session,
            submission: input.submission,
            eventIds: [...eventIds],
            checkpoint,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // A deferral failure belongs to this candidate, not to the settled session.
        if (result.kind === "wait")
          return await deferTurnStep({ ...input, afterRunId: result.runId });
        return result.receipt;
      }
    } finally {
      await inbox.dispose();
    }
    const receipt = await forwardSubmissionStep({
      token,
      candidateRunId: runId,
      submission: input.submission,
    });
    if (receipt?.terminal === true || receipt?.deliveries[input.submission.eventId] !== undefined)
      return receipt;
  }
}

async function executeClaimedTurn(
  input: TurnWorkflowInput,
  inbox: OwnerInbox,
  eventIds: Set<string>,
  observeCheckpoint: (ref: SnapshotRecordRef) => void,
): Promise<Exclude<TurnExecutionResult, { kind: "progress" }>> {
  const controller = new AbortController();
  let turnId = `turn_${inbox.address.ownerRunId}`;
  let taskId =
    input.submission.command.kind === "send"
      ? (input.submission.command.caller?.taskId ?? input.submission.initial?.taskId)
      : input.submission.initial?.taskId;
  let ownerFailure: { error: unknown } | undefined;
  const observeEnvelope = (envelope: InboxEnvelope): void => {
    const submission = submissionFromEnvelope(envelope);
    if (submission !== undefined) eventIds.add(submission.eventId);
    if (submission !== undefined && interruptionKind(submission, turnId, taskId) !== undefined) {
      controller.abort(new TurnCancelledError());
    }
  };
  const stopObserving = inbox.observe(observeEnvelope, (error) => {
    ownerFailure = { error };
    controller.abort(error);
  });
  let pending: InboxEnvelope[] = [];
  let nextRead: Promise<void> | undefined;
  const readNext = (): Promise<void> =>
    (nextRead ??= inbox.next().then(
      (envelope) => {
        pending.push(envelope);
        nextRead = undefined;
      },
      (error) => {
        ownerFailure = { error };
        controller.abort(error);
        nextRead = undefined;
      },
    ));
  const throwIfOwnerFailed = (): void => {
    if (ownerFailure !== undefined) throw ownerFailure.error;
  };
  const aliases = new Set<string>();
  const slept = new Set<string>();
  const executors = new Map<string, Promise<void>>();
  const completedExecutors = new Set<string>();
  const watchExecutors = (runIds: readonly string[]): void => {
    for (const runId of runIds) {
      if (executors.has(runId) || completedExecutors.has(runId)) continue;
      executors.set(
        runId,
        awaitRunStep(runId).then(
          () => {
            executors.delete(runId);
            completedExecutors.add(runId);
          },
          (error) => {
            executors.delete(runId);
            completedExecutors.add(runId);
            ownerFailure = { error };
            controller.abort(error);
          },
        ),
      );
    }
  };
  const claimAlias = async (token: string | undefined): Promise<void> => {
    if (token === undefined || token === "" || aliases.has(token)) return;
    const requestId = `${inbox.address.ownerRunId}:rekey:${token}`;
    const response = inbox.response(requestId).then(
      (reply) => ({ kind: "reply" as const, reply }),
      (error) => ({ kind: "error" as const, error }),
    );
    const sent = await sendInboxStep(input.session.control, {
      eventId: requestId,
      requestId,
      kind: "rekey",
      payload: { token, replyTo: inbox.address },
    });
    if (sent !== "delivered") throw new Error("Session holder is unavailable.");
    const received = await response;
    if (received.kind === "error") throw received.error;
    if ((received.reply.payload as { status: string }).status !== "claimed")
      throw new Error("Session continuation address could not be claimed.");
    aliases.add(token);
  };
  try {
    pending.push(...inbox.drain());
    pending.forEach(observeEnvelope);
    let result = await executeTurnStep({
      ...input,
      owner: inbox.address,
      work: { kind: "model" },
      abortSignal: controller.signal,
    });
    throwIfOwnerFailed();
    while (result.kind === "progress") {
      const progress = result.progress;
      turnId = progress.turnId;
      taskId = progress.taskId;
      observeCheckpoint(progress.checkpoint);
      if (progress.claimedContinuationToken !== undefined)
        aliases.add(progress.claimedContinuationToken);
      await claimAlias(progress.continuationToken);
      watchExecutors(progress.pendingRunIds ?? []);
      pending.push(...inbox.drain());
      if (
        progress.sleepDurationMs !== undefined &&
        !controller.signal.aborted &&
        pending.length === 0
      ) {
        const sleepKey = progress.sleepKey;
        if (sleepKey === undefined)
          throw new Error("A sleeping model result requires a stable sleep key.");
        if (!slept.has(sleepKey)) {
          slept.add(sleepKey);
          await Promise.race([sleep(progress.sleepDurationMs), readNext(), ...executors.values()]);
        }
      }
      throwIfOwnerFailed();
      pending.push(...inbox.drain());
      const decision = reduceTurnBoundary(progress, pending);
      if (decision.kind === "finalize") {
        const initialKind = interruptionKind(input.submission, turnId, taskId);
        const receipt = await finalizeTurnStep({
          session: input.session,
          checkpoint: progress.checkpoint,
          eventIds: [...eventIds],
          claimedContinuationToken: progress.continuationToken || undefined,
          kind:
            initialKind === "reset" || initialKind === "timeout"
              ? initialKind
              : decision.settlement,
          pending,
        });
        if (!receipt.terminal) await claimAlias(receipt.continuationToken);
        return { kind: "receipt", receipt };
      }
      if (decision.kind === "wait") {
        await Promise.race([readNext(), ...executors.values()]);
        throwIfOwnerFailed();
        continue;
      }
      const envelopes = pending;
      pending = [];
      result = await executeTurnStep({
        ...input,
        owner: inbox.address,
        checkpoint: progress.checkpoint,
        work:
          decision.kind === "model"
            ? { kind: "model", envelopes }
            : decision.kind === "events"
              ? { kind: "events", envelopes }
              : { kind: "dispatch" },
        abortSignal: controller.signal,
      });
      throwIfOwnerFailed();
      if (decision.kind === "dispatch") pending.push(...envelopes);
    }
    if (result.kind === "receipt" && !result.receipt.terminal)
      await claimAlias(result.receipt.continuationToken);
    return result;
  } finally {
    stopObserving();
    controller.abort(new TurnCancelledError());
  }
}
