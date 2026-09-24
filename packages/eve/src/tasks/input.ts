import { resolveTextToResponse } from "#channel/resolve-text.js";
import type {
  ChannelDeliveryMetadataEntry,
  DeliverHookPayload,
  DeliverPayload,
} from "#channel/types.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";
import type { TaskInputBatch, TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import type { TaskTable } from "#tasks/table.js";

// The requests a task waits on live only on its record. A child resolves its
// own requests and reports it, and the owner follows that report. Read by the
// session workflow body: no Node.js built-ins and no schema runtime.

/** The batches a task waits on after its child requested or resolved input. */
export function applyTaskInputEvent(
  batches: readonly TaskInputBatch[],
  event: Extract<TaskInputEvent, { readonly type: "input.requested" | "input.resolved" }>,
): readonly TaskInputBatch[] {
  if (event.type === "input.resolved") {
    const resolved = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
    return batches.flatMap((batch) => {
      const requests = batch.requests.filter((request) => !resolved.has(request.requestId));
      if (requests.length === batch.requests.length) return [batch];
      return requests.length === 0 ? [] : [{ ...batch, requests }];
    });
  }
  // A repeated report adds nothing; a request belongs to the batch that first carried it.
  const known = new Set(batches.flatMap((batch) => batch.requests.map((r) => r.requestId)));
  const requests = event.data.requests.filter((request) => !known.has(request.requestId));
  if (requests.length === 0) return batches;
  const { sequence, stepIndex, turnId } = event.data;
  return [...batches, { requests, sequence, stepIndex, turnId }];
}

/** One request a task waits on, with the batch it arrived in. */
export interface PendingTaskInput {
  readonly batch: TaskInputBatch;
  readonly record: TaskRecord;
  readonly request: TaskInputRequest;
}

export function pendingTaskInput(table: TaskTable): readonly PendingTaskInput[] {
  return table.records.flatMap((record) =>
    (record.input ?? []).flatMap((batch) =>
      batch.requests.map((request) => ({ batch, record, request })),
    ),
  );
}

export function hasPendingTaskInput(session: { readonly state?: SessionStateMap }): boolean {
  return getTaskTable(session).records.some((record) => record.input !== undefined);
}

/** A delivery's answers for one task's child. */
export interface TaskAnswers {
  readonly record: TaskRecord;
  readonly responses: readonly InputResponse[];
  /** Dismissible questions a person's message moved past without answering them. */
  readonly dismissed: readonly string[];
  /** Metadata of the payloads these answers used up, carried to the child. */
  readonly deliveryMetadata: readonly ChannelDeliveryMetadataEntry[];
}

export interface TaskAnswerPlan {
  readonly answers: readonly TaskAnswers[];
  /** A descendant's session-limit prompt was declined, which stops this session's turn. */
  readonly cancelTurn: boolean;
  /** What stays with this session; `undefined` when every payload was used up. */
  readonly remainder: DeliverHookPayload | undefined;
}

interface TaskAnswersDraft extends TaskAnswers {
  readonly responses: InputResponse[];
  readonly dismissed: string[];
  readonly deliveryMetadata: ChannelDeliveryMetadataEntry[];
}

/**
 * Decides where a delivery's answers go. A response goes to the task waiting
 * on its request, and the first response to a request wins. A person's plain
 * message, in a payload without responses, answers the only pending question
 * when it resolves against it, the way a session resolves text against its
 * own pending requests; otherwise it dismisses every dismissible question and
 * stays with this session. A delegating caller's message never answers.
 */
export function planTaskAnswers(input: {
  readonly delivery: DeliverHookPayload;
  readonly table: TaskTable;
}): TaskAnswerPlan {
  const { delivery } = input;
  const pending = new Map(
    pendingTaskInput(input.table).map((entry) => [entry.request.requestId, entry]),
  );
  const answers = new Map<string, TaskAnswersDraft>();
  const taken = new Set<string>();
  const take = (requestId: string) => {
    const entry = pending.get(requestId);
    if (entry === undefined) return undefined;
    pending.delete(requestId);
    taken.add(requestId);
    let task = answers.get(entry.record.id);
    if (task === undefined) {
      task = { deliveryMetadata: [], dismissed: [], record: entry.record, responses: [] };
      answers.set(entry.record.id, task);
    }
    return { request: entry.request, task };
  };

  let cancelTurn = false;
  const kept: (readonly [index: number, payload: DeliverPayload])[] = [];
  for (const [index, payload] of delivery.payloads.entries()) {
    const responses = [...(payload.inputResponses ?? [])];
    let message = payload.message;
    if (delivery.caller === undefined && responses.length === 0 && message !== undefined) {
      const questions = [...pending.values()].filter(({ request }) => request.kind === "question");
      const [only] = questions;
      const answer =
        questions.length === 1 && only !== undefined && typeof message === "string"
          ? resolveTextToResponse(message, only.request)
          : undefined;
      if (answer === undefined) {
        for (const { request } of questions) {
          if (request.dismissible !== true) continue;
          take(request.requestId)?.task.dismissed.push(request.requestId);
        }
      } else {
        responses.push(answer);
        message = undefined;
      }
    }

    const unrouted: InputResponse[] = [];
    let answered: TaskAnswersDraft | undefined;
    for (const response of responses) {
      const routed = take(response.requestId);
      if (routed === undefined) {
        if (!taken.has(response.requestId)) unrouted.push(response);
        continue;
      }
      if (
        routed.request.kind === "session-limit" &&
        response.optionId === SESSION_LIMIT_STOP_OPTION_ID
      ) {
        cancelTurn = true;
      }
      routed.task.responses.push(response);
      answered ??= routed.task;
    }

    const inputResponses = unrouted.length === 0 ? undefined : unrouted;
    const rest = Object.fromEntries(
      Object.entries({ ...payload, inputResponses, message }).filter(([, v]) => v !== undefined),
    ) as DeliverPayload;
    if (Object.keys(rest).length > 0) kept.push([index, rest]);
    else answered?.deliveryMetadata.push(...metadataOf(delivery, index, 0));
  }

  if (answers.size === 0) return { answers: [], cancelTurn: false, remainder: delivery };
  const metadata = kept.flatMap(([index], payloadIndex) =>
    metadataOf(delivery, index, payloadIndex),
  );
  const remainder =
    kept.length === 0
      ? undefined
      : {
          ...delivery,
          deliveryMetadata: metadata.length === 0 ? undefined : metadata,
          payloads: kept.map(([, payload]) => payload),
        };
  return { answers: [...answers.values()], cancelTurn, remainder };
}

/** A source payload's metadata, moved to `payloadIndex` in a new delivery. */
function metadataOf(delivery: DeliverHookPayload, from: number, payloadIndex: number) {
  return (delivery.deliveryMetadata ?? []).flatMap((entry) =>
    entry.payloadIndex === from ? [{ ...entry, payloadIndex }] : [],
  );
}
