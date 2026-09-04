import type { DeliverHookPayload } from "#channel/types.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type {
  AcceptedSubmission,
  PendingSubmission,
  InitializedSessionCheckpoint,
  TurnSettlementKind,
} from "#execution/turn/types.js";

export function commandDelivery(submission: AcceptedSubmission): DeliverHookPayload {
  if (submission.command.kind !== "send") throw new Error("Expected a message submission.");
  const command = submission.command;
  return {
    kind: "deliver",
    payloads: [command.payload],
    auth: command.auth,
    caller: command.caller,
    requestId: command.requestId,
    taskDeliveryId: command.taskDeliveryId,
    turnPolicy: command.turnPolicy,
    deliveryMetadata:
      command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
  };
}

export function admitSubmissions(
  checkpoint: InitializedSessionCheckpoint,
  pending: readonly PendingSubmission[],
): InitializedSessionCheckpoint {
  const queue = [...checkpoint.queue];
  const inputs = [...(checkpoint.inputs ?? [])];
  for (const item of pending.flatMap(splitSubmission)) {
    const submission = item.submission;
    if (
      checkpoint.deliveries[submission.eventId] !== undefined ||
      queue.some((item) => item.submission.eventId === submission.eventId) ||
      inputs.some((input) => input.submission.eventId === submission.eventId)
    )
      continue;
    const command = submission.command;
    const canSteer =
      command.kind === "send" &&
      (command.turnPolicy ?? "steer") === "steer" &&
      (command.caller === undefined || command.caller.callId === checkpoint.caller?.callId);
    const response =
      command.kind === "send" &&
      command.payload.message === undefined &&
      (command.payload.inputResponses?.length ?? 0) > 0;
    if (canSteer || response || command.kind === "runtime") inputs.push(item);
    else queue.push(item);
  }
  let admitted: InitializedSessionCheckpoint = { ...checkpoint, inputs, queue };
  for (const item of pending) admitted = retireTaskSubmissions(admitted, item.submission);
  if (admitted.queue.length + (admitted.inputs?.length ?? 0) > 256)
    throw new Error("Session pending input capacity exceeded.");
  return admitted;
}

export function splitSubmission(item: PendingSubmission): PendingSubmission[] {
  const command = item.submission.command;
  if (
    command.kind !== "send" ||
    command.payload.message === undefined ||
    (command.payload.inputResponses?.length ?? 0) === 0
  )
    return [item];
  const { inputResponses: _inputResponses, ...message } = command.payload;
  const {
    message: _message,
    context: _context,
    outputSchema: _outputSchema,
    ...response
  } = command.payload;
  return [
    {
      ...item,
      submission: {
        ...item.submission,
        eventId: `${item.submission.eventId}:response`,
        command: { ...command, payload: response, caller: undefined },
      },
    },
    { ...item, submission: { ...item.submission, command: { ...command, payload: message } } },
  ];
}

/** Cancels only work admitted on behalf of the addressed task. */
export function retireTaskSubmissions(
  checkpoint: InitializedSessionCheckpoint,
  submission: AcceptedSubmission,
): InitializedSessionCheckpoint {
  const command = submission.command;
  if (command.kind !== "cancel" || command.taskId === undefined) return checkpoint;
  const turnId = checkpoint.state.emissionState.turnId || `turn_${checkpoint.writerRunId}`;
  const matchesTurn = command.turnId === undefined || command.turnId === turnId;
  const pending = [...checkpoint.queue, ...(checkpoint.inputs ?? [])];
  // A mixed message/answer keeps one candidate identity after splitting.
  const cancelledCandidates = new Set(
    matchesTurn
      ? pending
          .filter(
            (item) =>
              item.submission.command.kind === "send" &&
              item.submission.command.caller?.taskId === command.taskId,
          )
          .map((item) => item.candidateRunId)
      : [],
  );
  const deliveries = { ...checkpoint.deliveries };
  const retain = (item: PendingSubmission): boolean => {
    if (item.submission.eventId === submission.eventId) return false;
    if (!cancelledCandidates.has(item.candidateRunId)) return true;
    deliveries[item.submission.eventId] = "retired";
    return false;
  };
  const queue = checkpoint.queue.filter(retain);
  const inputs = checkpoint.inputs?.filter(retain);
  deliveries[submission.eventId] =
    cancelledCandidates.size > 0 || (matchesTurn && checkpoint.caller?.taskId === command.taskId)
      ? "applied"
      : "retired";
  return { ...checkpoint, queue, inputs, deliveries };
}

/** Unconsumed messages retain their accepting candidate and deployment through finalization. */
export function accountPending(
  checkpoint: InitializedSessionCheckpoint,
  envelopes: readonly InboxEnvelope[],
  kind: TurnSettlementKind,
): InitializedSessionCheckpoint {
  const queue = [...checkpoint.queue];
  for (const item of [
    ...(checkpoint.inputs ?? []),
    ...envelopes.flatMap((envelope) =>
      envelope.kind === "session.submit" ? [envelope.payload as PendingSubmission] : [],
    ),
  ]) {
    if (
      checkpoint.deliveries[item.submission.eventId] === undefined &&
      !queue.some((queued) => queued.submission.eventId === item.submission.eventId)
    )
      queue.push(item);
  }
  let accounted: InitializedSessionCheckpoint = { ...checkpoint, queue, inputs: [] };
  for (const item of queue) accounted = retireTaskSubmissions(accounted, item.submission);
  const deliveries = { ...accounted.deliveries };
  const turnId = checkpoint.state.emissionState.turnId || `turn_${checkpoint.writerRunId}`;
  const retained = accounted.queue.filter((item) => {
    const command = item.submission.command;
    if (command.kind === "cancel") {
      deliveries[item.submission.eventId] =
        kind === "cancel" && (command.turnId === undefined || command.turnId === turnId)
          ? "applied"
          : "retired";
      return false;
    }
    if (
      (command.kind === "reset" && kind === "reset") ||
      (command.kind === "session-timeout" && kind === "timeout")
    ) {
      deliveries[item.submission.eventId] = "applied";
      return false;
    }
    return true;
  });
  if (retained.length > 256) throw new Error("Session pending input capacity exceeded.");
  return { ...accounted, queue: retained, deliveries };
}
