import { activeTurnToken } from "#execution/turn/address.js";
import { getWorkflowMetadata, sleep } from "#compiled/@workflow/core/index.js";
import { createOwnerInbox } from "#execution/inbox/owner.js";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import { awaitTurnStep, forwardSubmissionStep } from "#execution/turn/admission.js";
import { awaitRunStep } from "#execution/await-run.js";
import { executeTurnStep, acknowledgeTurnWorkStep } from "#execution/turn/execute.js";
import {
  failTurnStep,
  finalizeTurnStep,
  commitTurnStep,
  closeSessionStep,
} from "#execution/turn/finalize.js";
import {
  interruptionKind,
  reduceTurnBoundary,
  submissionFromEnvelope,
} from "#execution/turn/reduce.js";
import type { TurnExecutionResult, TurnReceipt, TurnWorkflowInput } from "#execution/turn/types.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { InitializedSessionCheckpoint } from "#execution/turn/types.js";
import type { SessionCheckpoint } from "#execution/turn/types.js";
import { deferTurnStep } from "#execution/session/dispatch.js";

type ClaimedTurnResult =
  | Exclude<TurnExecutionResult, { kind: "progress" }>
  | { readonly kind: "settled"; readonly checkpoint: SessionCheckpoint };

export async function turnWorkflow(input: TurnWorkflowInput): Promise<TurnReceipt> {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  const token = activeTurnToken(input.session.sessionId);
  let checkpoint: InitializedSessionCheckpoint | undefined;
  if (input.afterRunId !== undefined) await awaitTurnStep(input.afterRunId);
  let controller: AbortController | undefined;
  while (true) {
    const inbox = createOwnerInbox({ token });
    // Queue both hook registrations before the ownership suspension.
    controller ??= new AbortController();
    try {
      const claim = await inbox.claim();
      if (claim.kind === "owned") {
        const eventIds = new Set([input.submission.eventId]);
        let result: ClaimedTurnResult;
        try {
          result = await executeClaimedTurn(input, inbox, controller, eventIds, (state) => {
            checkpoint = state;
          });
        } catch (error) {
          const failed = await failTurnStep({
            session: input.session,
            submission: input.submission,
            eventIds: [...eventIds],
            checkpoint,
            error: error instanceof Error ? error.message : String(error),
          });
          result = { kind: "settled", checkpoint: failed };
        }
        // A deferral failure belongs to this candidate, not to the settled session.
        if (result.kind === "wait")
          return await deferTurnStep({ ...input, afterRunId: result.runId });
        if (result.kind === "settled") {
          const receipt = await commitTurnStep({
            session: input.session,
            checkpoint: result.checkpoint,
            eventIds: [...eventIds],
          });
          if (receipt.terminal) await closeSessionStep(input.session, result.checkpoint);
          return receipt;
        }
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
  controller: AbortController,
  eventIds: Set<string>,
  observeCheckpoint: (checkpoint: InitializedSessionCheckpoint) => void,
): Promise<ClaimedTurnResult> {
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
  const acknowledgedSteps = new Set<string>();
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
    while (result.kind === "progress") {
      const progress = result.progress;
      turnId = progress.turnId;
      taskId = progress.taskId;
      observeCheckpoint(progress.checkpoint);
      throwIfOwnerFailed();
      const tools = progress.checkpoint.pendingToolAcks ?? [];
      const tasks = progress.checkpoint.pendingTaskAcks ?? [];
      if (
        (tools.length > 0 || tasks.length > 0) &&
        !acknowledgedSteps.has(progress.checkpoint.writeId)
      ) {
        await acknowledgeTurnWorkStep({ tools, tasks });
        acknowledgedSteps.add(progress.checkpoint.writeId);
      }
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
      pending = pending.filter((envelope) => {
        const submission = submissionFromEnvelope(envelope);
        return (
          submission === undefined ||
          progress.checkpoint.deliveries[submission.eventId] === undefined
        );
      });
      const decision = reduceTurnBoundary(progress, pending);
      if (decision.kind === "finalize") {
        const initialKind = interruptionKind(input.submission, turnId, taskId);
        let settled = await finalizeTurnStep({
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
        const terminal = settled.phase === "terminal" || settled.phase === "initialization-failed";
        if (!terminal && settled.phase !== "initialization-failed") {
          await claimAlias(settled.state.continuationToken);
          settled = {
            ...settled,
            claimedContinuationToken: settled.state.continuationToken || undefined,
          };
        }
        return { kind: "settled", checkpoint: settled };
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
      if (decision.kind === "dispatch") pending.push(...envelopes);
    }
    throwIfOwnerFailed();
    if (result.kind === "receipt" && !result.receipt.terminal)
      await claimAlias(result.receipt.continuationToken);
    return result;
  } finally {
    stopObserving();
  }
}
