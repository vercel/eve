import type { SessionStateMap } from "#harness/types.js";
import { getBackgroundTasks, type BackgroundTasks } from "#harness/workflow-tool-runs.js";
import { hasRecordedTaskOutcome, taskIdOfDelivery } from "#tasks/notification.js";
import type { TaskDeliveryPolicy, DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { jsonValuesEqual } from "#shared/json.js";

export type SessionControl = "clear" | "compact" | "expired" | "reset";

export interface DeliveryAdmission {
  readonly delivery: DeliverHookPayload;
  readonly sequence: number;
}

interface QueuedDelivery extends DeliveryAdmission {
  readonly kind: "delivery";
}

interface QueuedControl {
  readonly control: SessionControl;
  readonly kind: "control";
  readonly sequence: number;
}

interface QueuedAuthorization {
  readonly attemptId: string;
  readonly kind: "authorization";
  readonly payload: DeliverPayload;
  readonly sequence: number;
}

type QueuedSessionInput = QueuedDelivery | QueuedControl | QueuedAuthorization;

export interface TurnSelection {
  readonly delivery: DeliverHookPayload;
  /**
   * True only for a lone, callerless conversational delivery that arrived
   * while nothing else was pending. Such a delivery may move the session to
   * the deployment that accepted it.
   */
  readonly handoffEligible: boolean;
  readonly kind: "turn";
  /** Sequences of every admission folded into this turn. */
  readonly sequences: readonly number[];
}

export type SessionInputSelection =
  | TurnSelection
  | { readonly control: SessionControl; readonly kind: "control" }
  | { readonly kind: "authorization-resume"; readonly payloads: readonly DeliverPayload[] };

/**
 * Ordered, admitted session input, plus the idempotency and cancellation
 * facts for task deliveries this owner has seen. Entries are private; callers
 * receive typed admission and selection values. Everything here is rebuilt
 * deterministically on replay. Indexed task outcomes live in session state.
 */
export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private readonly cancelledTaskIds = new Set<string>();
  private readonly seenTaskDeliveryIds = new Set<string>();
  private nextSequence = 0;

  get pendingCount(): number {
    return this.entries.length;
  }

  /** Drops notifications the model must not see; lifecycle envelopes are always admitted. */
  enqueueDelivery(
    delivery: DeliverHookPayload,
    state?: SessionStateMap,
  ): DeliveryAdmission | undefined {
    if (isStaleNotification(delivery, state)) return undefined;
    const deliveryId = taskDeliveryId(delivery);
    if (deliveryId !== undefined) {
      const terminalId = terminalTaskId(delivery);
      // Competing outcomes for one task must not produce separate cohort reports.
      const deduplicationId = terminalId === undefined ? deliveryId : `${terminalId}:ready`;
      if (this.seenTaskDeliveryIds.has(deduplicationId) || this.isCancelledNotification(delivery)) {
        return undefined;
      }
      this.seenTaskDeliveryIds.add(deduplicationId);
    }
    const admission = { delivery, sequence: this.nextSequence++ };
    this.entries.push({ ...admission, kind: "delivery" });
    return admission;
  }

  /** A caller's own task id counts as seen so its echo is not admitted twice. */
  rememberTask(taskId: string): void {
    this.seenTaskDeliveryIds.add(taskId);
  }

  isTaskCancelled(taskId: string): boolean {
    return this.cancelledTaskIds.has(taskId);
  }

  enqueueControl(control: SessionControl): void {
    this.entries.push({ control, kind: "control", sequence: this.nextSequence++ });
  }

  /** Keeps one payload per authorization attempt; a repeated callback for the same attempt is dropped. */
  enqueueAuthorization(payloads: readonly DeliverPayload[]): void {
    for (const payload of payloads) {
      const attemptId = authorizationAttemptId(payload);
      if (attemptId === undefined) continue;
      if (
        this.entries.some(
          (entry) => entry.kind === "authorization" && entry.attemptId === attemptId,
        )
      )
        continue;
      this.entries.push({
        attemptId,
        kind: "authorization",
        payload,
        sequence: this.nextSequence++,
      });
    }
  }

  delivery(sequence: number): DeliverHookPayload | undefined {
    const entry = this.entries.find(
      (candidate): candidate is QueuedDelivery =>
        candidate.kind === "delivery" && candidate.sequence === sequence,
    );
    return entry?.delivery;
  }

  /** Task lifecycle effects must be applied even while their cohort report is held. */
  taskDeliveries(): readonly DeliveryAdmission[] {
    return this.entries.filter(
      (entry): entry is QueuedDelivery =>
        entry.kind === "delivery" && !isNotificationOnly(entry.delivery),
    );
  }

  replaceDelivery(sequence: number, delivery: DeliverHookPayload | undefined): void {
    const index = this.entries.findIndex(
      (entry) => entry.kind === "delivery" && entry.sequence === sequence,
    );
    if (index < 0) return;
    if (delivery === undefined || this.isCancelledNotification(delivery)) {
      this.entries.splice(index, 1);
      return;
    }
    this.entries[index] = { delivery, kind: "delivery", sequence };
  }

  /** Revokes model wakeups for a cancelled task; its lifecycle envelopes still reach routing. */
  cancelTask(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    this.discardDeliveries((delivery) => this.isCancelledNotification(delivery));
  }

  /** After cancellation records outcomes, queued notifications for those tasks are stale. */
  discardStaleNotifications(state: SessionStateMap | undefined): void {
    this.discardDeliveries((delivery) => isStaleNotification(delivery, state));
  }

  takeSteering(
    admitted: ReadonlySet<number>,
    callerCallId: string | undefined,
  ): TurnSelection | undefined {
    const steering = this.entries.filter(
      (entry): entry is QueuedDelivery =>
        entry.kind === "delivery" &&
        admitted.has(entry.sequence) &&
        isSteeringDelivery(entry.delivery, callerCallId),
    );
    if (steering.length === 0) return undefined;
    this.retain((entry) => entry.kind !== "delivery" || !steering.includes(entry));
    return {
      delivery: combine(steering),
      handoffEligible: false,
      kind: "turn",
      sequences: steering.map(({ sequence }) => sequence),
    };
  }

  takeNext(
    state: SessionStateMap | undefined,
    options?: {
      readonly deferDeliveries?: boolean;
      readonly taskDeliveryPolicy?: TaskDeliveryPolicy;
      /**
       * Attempt ids of the open authorization challenge. Callbacks for other
       * attempts are stale and dropped; once every expected attempt has
       * reported, the collected payloads resume the challenge ahead of
       * ordinary input.
       */
      readonly expectedAttemptIds?: ReadonlySet<string>;
      /** Sequence of a delivery admitted while nothing else was pending. */
      readonly freshSequence?: number;
    },
  ): SessionInputSelection | undefined {
    const expected = options?.expectedAttemptIds ?? new Set<string>();
    this.retain((entry) => entry.kind !== "authorization" || expected.has(entry.attemptId));
    if (expected.size > 0) {
      const collected = new Map(
        this.entries.flatMap((entry) =>
          entry.kind === "authorization" ? [[entry.attemptId, entry.payload] as const] : [],
        ),
      );
      if ([...expected].every((attemptId) => collected.has(attemptId))) {
        this.retain((entry) => entry.kind !== "authorization");
        return {
          kind: "authorization-resume",
          payloads: [...expected].map((attemptId) => collected.get(attemptId)!),
        };
      }
    }
    const tasks = getBackgroundTasks(state);
    // A cohort reports once every task is ready; a cancelled task's notification may never arrive.
    const pendingCohorts = new Set(
      tasks
        .query({ state: "working" })
        .filter(
          ({ taskId }) =>
            !this.seenTaskDeliveryIds.has(`${taskId}:ready`) && !this.cancelledTaskIds.has(taskId),
        )
        .map((task) => task.cohortId),
    );
    const index = this.nextActionableIndex(
      tasks,
      pendingCohorts,
      options?.deferDeliveries === true,
      options?.taskDeliveryPolicy ?? "cohort",
    );
    if (index < 0) return undefined;
    return this.takeSelectionAt(index, tasks, options?.freshSequence);
  }

  private nextActionableIndex(
    tasks: BackgroundTasks,
    pendingCohorts: ReadonlySet<string>,
    deferDeliveries: boolean,
    taskDeliveryPolicy: TaskDeliveryPolicy,
  ): number {
    return this.entries.findIndex((entry) => {
      if (entry.kind === "control") return true;
      if (entry.kind === "authorization" || deferDeliveries) return false;
      if (this.isCancelledDelivery(entry.delivery)) return false;
      const cohort = terminalCohort(entry.delivery, tasks);
      return taskDeliveryPolicy === "auto" || cohort === undefined || !pendingCohorts.has(cohort);
    });
  }

  private takeSelectionAt(
    index: number,
    tasks: BackgroundTasks,
    freshSequence: number | undefined,
  ): SessionInputSelection {
    const selected = this.entries[index]!;
    if (selected.kind !== "delivery") {
      this.entries.splice(index, 1);
      if (selected.kind === "control") return { control: selected.control, kind: "control" };
      return { kind: "authorization-resume", payloads: [selected.payload] };
    }
    const readyCohort = terminalCohort(selected.delivery, tasks);
    if (readyCohort !== undefined) {
      const lastSibling = this.entries.findLastIndex(
        (entry) =>
          entry.kind === "delivery" &&
          !this.isCancelledDelivery(entry.delivery) &&
          terminalCohort(entry.delivery, tasks) === readyCohort,
      );
      const boundary = this.entries.findIndex(
        (entry, position) =>
          position > index &&
          position < lastSibling &&
          (entry.kind !== "delivery" ||
            (!this.isCancelledDelivery(entry.delivery) &&
              terminalCohort(entry.delivery, tasks) === undefined)),
      );
      if (boundary >= 0) return this.takeSelectionAt(boundary, tasks, freshSequence);
    }

    const first = this.entries.splice(index, 1)[0]!;
    if (first.kind !== "delivery") throw new Error("Selected a non-delivery entry as a turn.");
    const turnEntries = [first];
    const cohort = terminalCohort(first.delivery, tasks);
    if (cohort !== undefined) {
      const siblings = this.entries.filter(
        (entry): entry is QueuedDelivery =>
          entry.kind === "delivery" &&
          !this.isCancelledDelivery(entry.delivery) &&
          terminalCohort(entry.delivery, tasks) === cohort,
      );
      turnEntries.push(...siblings);
      this.retain((entry) => entry.kind !== "delivery" || !siblings.includes(entry));
    } else {
      const authenticated =
        first.delivery.auth != null && first.delivery.auth.principalType !== "anonymous";
      let caller = first.delivery.caller;
      while (this.entries.length > index) {
        const next = this.entries[index];
        if (
          next?.kind !== "delivery" ||
          first.delivery.taskDeliveryId !== undefined ||
          next.delivery.taskDeliveryId !== undefined ||
          !authenticated ||
          !jsonValuesEqual(first.delivery.auth, next.delivery.auth) ||
          (caller !== undefined && next.delivery.caller !== undefined)
        ) {
          break;
        }
        turnEntries.push(this.entries.splice(index, 1)[0] as QueuedDelivery);
        caller ??= next.delivery.caller;
      }
    }

    const sequences = turnEntries.map(({ sequence }) => sequence);
    const combined = combine(turnEntries);
    return {
      delivery: combined,
      handoffEligible:
        sequences.length === 1 &&
        sequences[0] === freshSequence &&
        combined.caller === undefined &&
        taskDeliveryId(combined) === undefined &&
        this.entries.length === 0,
      kind: "turn",
      sequences,
    };
  }

  private isCancelledDelivery(delivery: DeliverHookPayload): boolean {
    const deliveryId = taskDeliveryId(delivery);
    return deliveryId !== undefined && this.cancelledTaskIds.has(taskIdOfDelivery(deliveryId));
  }

  /** A cancelled task's notification never reaches the model. */
  private isCancelledNotification(delivery: DeliverHookPayload): boolean {
    return isNotificationOnly(delivery) && this.isCancelledDelivery(delivery);
  }

  private discardDeliveries(predicate: (delivery: DeliverHookPayload) => boolean): void {
    this.retain((entry) => entry.kind !== "delivery" || !predicate(entry.delivery));
  }

  private retain(predicate: (entry: QueuedSessionInput) => boolean): void {
    const kept = this.entries.filter(predicate);
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

/** Carries only model-facing text, without `payload.task` envelopes that routing must apply. */
function isNotificationOnly(delivery: DeliverHookPayload): boolean {
  return delivery.payloads.every((payload) => payload.task === undefined);
}

/** A notification for a task whose outcome the parent already recorded and reported. */
function isStaleNotification(
  delivery: DeliverHookPayload,
  state: SessionStateMap | undefined,
): boolean {
  return isNotificationOnly(delivery) && hasRecordedTaskOutcome(delivery, state);
}

export function isSteeringDelivery(
  delivery: DeliverHookPayload,
  callerCallId: string | undefined,
): boolean {
  return (
    delivery.taskDeliveryId === undefined &&
    (delivery.turnPolicy ?? "steer") === "steer" &&
    (delivery.caller === undefined || delivery.caller.callId === callerCallId)
  );
}

function combine(entries: readonly DeliveryAdmission[]): DeliverHookPayload {
  if (entries.length === 1) return entries[0]!.delivery;
  const deliveries = entries.map(({ delivery }) => delivery);
  const taskDeliveryIds = deliveries.flatMap(
    (delivery) =>
      delivery.taskDeliveryIds ??
      (delivery.taskDeliveryId === undefined ? [] : [delivery.taskDeliveryId]),
  );
  return {
    ...coalesceDeliveries(deliveries),
    taskDeliveryIds: taskDeliveryIds.length > 0 ? taskDeliveryIds : undefined,
  };
}

function authorizationAttemptId(payload: DeliverPayload): string | undefined {
  const callback = payload["authorizationCallback"] as { readonly attemptId?: unknown } | undefined;
  return typeof callback?.attemptId === "string" ? callback.attemptId : undefined;
}

function taskDeliveryId(delivery: DeliverHookPayload): string | undefined {
  return delivery.taskDeliveryId ?? delivery.caller?.taskId;
}

function terminalCohort(delivery: DeliverHookPayload, tasks: BackgroundTasks): string | undefined {
  const taskId = terminalTaskId(delivery);
  return taskId === undefined ? undefined : tasks.get(taskId)?.cohortId;
}

function terminalTaskId(delivery: DeliverHookPayload): string | undefined {
  if (delivery.caller !== undefined) return undefined;
  for (const status of ["completed", "failed", "cancelled"]) {
    const suffix = `:ready:${status}`;
    if (delivery.taskDeliveryId?.endsWith(suffix)) {
      return delivery.taskDeliveryId.slice(0, -suffix.length);
    }
  }
  return undefined;
}
