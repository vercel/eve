import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { AcceptedSubmission, PendingSubmission, TurnProgress } from "#execution/turn/types.js";
import type { TurnSettlementKind } from "#execution/turn/types.js";

export function submissionFromEnvelope(envelope: InboxEnvelope): AcceptedSubmission | undefined {
  return envelope.kind === "session.submit"
    ? (envelope.payload as PendingSubmission).submission
    : undefined;
}

export function interruptionKind(
  submission: AcceptedSubmission,
  turnId: string | undefined,
  taskId?: string,
): Exclude<TurnSettlementKind, "natural" | "failure"> | undefined {
  const command = submission.command;
  if (command.kind === "reset") return "reset";
  if (command.kind === "session-timeout") return "timeout";
  if (
    command.kind === "cancel" &&
    (command.turnId === undefined || command.turnId === turnId) &&
    (command.taskId === undefined || command.taskId === taskId)
  )
    return "cancel";
  if (
    command.kind === "send" &&
    command.turnPolicy === "interrupt" &&
    command.payload.message !== undefined
  )
    return "interrupt";
  return undefined;
}

export function reduceTurnBoundary(
  progress: TurnProgress,
  pending: readonly InboxEnvelope[],
):
  | { readonly kind: "finalize"; readonly settlement: TurnSettlementKind }
  | { readonly kind: "model" | "dispatch" | "wait" | "events" } {
  const controls = pending
    .map(submissionFromEnvelope)
    .filter((value): value is AcceptedSubmission => value !== undefined)
    .map((submission) => interruptionKind(submission, progress.turnId, progress.taskId));
  for (const kind of ["reset", "timeout", "cancel", "interrupt"] as const) {
    if (controls.includes(kind)) return { kind: "finalize", settlement: kind };
  }
  if (progress.action === "cancelled") return { kind: "finalize", settlement: "cancel" };
  if (progress.terminal) return { kind: "finalize", settlement: "natural" };
  const applicable = pending.some((envelope) => {
    const submission = submissionFromEnvelope(envelope);
    if (submission === undefined) return true;
    const command = submission.command;
    return (
      command.kind === "runtime" ||
      (command.kind === "cancel" && command.taskId !== undefined) ||
      (command.kind === "send" &&
        ((command.turnPolicy ?? "steer") === "steer" ||
          (command.payload.inputResponses?.length ?? 0) > 0))
    );
  });
  if (progress.action === "wait") return { kind: applicable ? "events" : "wait" };
  if (progress.action === "dispatch") return { kind: "dispatch" };
  if (progress.action === "continue" || applicable) return { kind: "model" };
  return { kind: "finalize", settlement: "natural" };
}
