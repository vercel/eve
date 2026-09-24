import { resolveTextToResponse } from "#channel/resolve-text.js";
import type {
  ChannelDeliveryMetadataEntry,
  DeliverHookPayload,
  DeliverPayload,
} from "#channel/types.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputResolution } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import type { TaskInputBatch, TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import type { TaskTable } from "#tasks/table.js";

// The requests a task waits on live only on its record, and every change to
// them is published as an input event for the task. Read by the session
// workflow body: no Node.js built-ins and no schema runtime.

/** A human-input event this owner publishes for one of its tasks. */
export interface TaskInputPublication {
  readonly event: TaskInputEvent;
  readonly taskId: string;
}

/** The batches a task waits on after an `input.requested` or `input.resolved` for it. */
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
  const requests = event.data.requests
    .filter((request) => !known.has(request.requestId))
    .map(({ allowFreeform, dismissible, kind, options, requestId }: TaskInputRequest) =>
      withoutUndefined({ allowFreeform, dismissible, kind, options, requestId }),
    );
  if (requests.length === 0) return batches;
  const { sequence, stepIndex, taskId: from, turnId } = event.data;
  return [...batches, withoutUndefined({ from, requests, sequence, stepIndex, turnId })];
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

/**
 * Whether the session itself waits on an input batch, read raw so the
 * workflow body does not import the harness.
 */
export function hasOwnPendingInput(state: SessionStateMap | undefined): boolean {
  const batches = state?.["eve.runtime.pendingInputBatches"];
  return (
    (Array.isArray(batches) && batches.length > 0) ||
    state?.["eve.runtime.pendingInputBatch"] !== undefined
  );
}

/** The requests tasks waited on in `before` that no task waits on in `after`. */
export function withdrawnTaskInput(
  before: TaskTable,
  after: TaskTable,
): readonly PendingTaskInput[] {
  const kept = new Set(pendingTaskInput(after).map(({ request }) => request.requestId));
  return pendingTaskInput(before).filter(({ request }) => !kept.has(request.requestId));
}

/**
 * One `input.resolved` per batch the requests came in: `answered` with the
 * response the owner sent, `ignored` for a request dismissed or withdrawn.
 */
export function taskInputResolutions(
  entries: readonly PendingTaskInput[],
  responses: ReadonlyMap<string, InputResponse> = new Map(),
): readonly TaskInputPublication[] {
  const batches = new Map<TaskInputBatch, { taskId: string; resolutions: InputResolution[] }>();
  for (const { batch, record, request } of entries) {
    const { kind, requestId } = request;
    const response = responses.get(requestId);
    const group = batches.get(batch) ?? { resolutions: [], taskId: record.id };
    group.resolutions.push(
      response === undefined
        ? { kind, outcome: "ignored", requestId }
        : { kind, outcome: "answered", requestId, response },
    );
    batches.set(batch, group);
  }
  return [...batches].map(([{ sequence, stepIndex, turnId }, { resolutions, taskId }]) => ({
    event: { data: { resolutions, sequence, stepIndex, turnId }, type: "input.resolved" },
    taskId,
  }));
}

/** The events to publish for a child's input event, and the requested IDs refused. */
export interface AdmittedTaskInput {
  readonly events: readonly TaskInputEvent[];
  readonly refused: readonly string[];
}

/**
 * Admits one input event from a task's child. A child resolves only requests
 * its own task waits on: a resolution keeps just those and is dropped when
 * none remain, which also drops a repeat. A requested ID already pending on
 * another task or on this session itself (`sessionPending`) is refused, so no
 * child can take the answers meant for another; one pending on this task is
 * a repeat.
 *
 * A retried child step asks again at the coordinates of its first batch,
 * which the child never resolves, so that batch is withdrawn first. Only an
 * agent's own batches (no `taskId`, no `from`) are compared: an agent asks
 * once per step for itself, and a new turn or step moves past a batch it
 * leaves open, so two of its own batches meet at one set of coordinates only
 * after a retry. Batches it surfaces for its own tasks never replace: a
 * descendant numbers its turns like any session, and a workflow run asks
 * every question at its call's coordinates, so they share coordinates while
 * live. Each such batch goes when its asker resolves or withdraws it.
 */
export function admitTaskInputEvent(input: {
  readonly event: TaskInputEvent;
  readonly record: TaskRecord;
  readonly sessionPending: ReadonlySet<string>;
  readonly table: TaskTable;
}): AdmittedTaskInput {
  const { event, record } = input;
  const own = new Set<string>();
  const taken = new Set(input.sessionPending);
  for (const entry of pendingTaskInput(input.table)) {
    (entry.record.id === record.id ? own : taken).add(entry.request.requestId);
  }
  if (event.type === "input.resolved") {
    const resolutions = event.data.resolutions.filter(({ requestId }) => own.has(requestId));
    const events =
      resolutions.length === 0 ? [] : [{ ...event, data: { ...event.data, resolutions } }];
    return { events, refused: [] };
  }
  if (event.type !== "input.requested") return { events: [event], refused: [] };

  const refused = event.data.requests.flatMap(({ requestId }) =>
    taken.has(requestId) ? [requestId] : [],
  );
  const requests = event.data.requests.filter(
    ({ requestId }) => !taken.has(requestId) && !own.has(requestId),
  );
  const { sequence, stepIndex, turnId } = event.data;
  const retried =
    record.kind === "agent" && event.data.taskId === undefined
      ? record.input?.find(
          (batch) =>
            batch.from === undefined &&
            batch.turnId === turnId &&
            batch.sequence === sequence &&
            batch.stepIndex === stepIndex,
        )
      : undefined;
  const asked = new Set(event.data.requests.map(({ requestId }) => requestId));
  const withdrawn =
    retried === undefined
      ? []
      : taskInputResolutions(
          retried.requests.flatMap((request) =>
            asked.has(request.requestId) ? [] : [{ batch: retried, record, request }],
          ),
        );
  const events = withdrawn.map((publication) => publication.event);
  if (requests.length > 0) events.push({ ...event, data: { ...event.data, requests } });
  return { events, refused };
}

/**
 * The resolutions the owner publishes once a task's child has its answers. A
 * question the child asked itself takes the answer it was sent, and a
 * dismissed one is ignored, so neither takes a second answer. An approval
 * stays until the child resolves it: the child's response policy may refuse
 * the responder and keep the request pending for another. So does a
 * descendant's request (`from`), which the child passes on and resolves once
 * the answer reaches the session that asked.
 */
export function sentAnswerResolutions(answers: TaskAnswers): readonly TaskInputPublication[] {
  const { record } = answers;
  const responses = new Map(answers.responses.map((response) => [response.requestId, response]));
  const dismissed = new Set(answers.dismissed);
  return taskInputResolutions(
    (record.input ?? []).flatMap((batch) =>
      batch.from !== undefined
        ? []
        : batch.requests.flatMap((request) =>
            dismissed.has(request.requestId) ||
            (request.kind !== "tool-approval" && responses.has(request.requestId))
              ? [{ batch, record, request }]
              : [],
          ),
    ),
    responses,
  );
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
 * stays with this session. While this session waits on its own approval or
 * session-limit prompt (`sessionAsks`), the text is left to those. A
 * delegating caller's message never answers.
 */
export function planTaskAnswers(input: {
  readonly delivery: DeliverHookPayload;
  readonly sessionAsks?: boolean;
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
        input.sessionAsks !== true &&
        questions.length === 1 &&
        only !== undefined &&
        typeof message === "string"
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

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
