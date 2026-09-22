import type { TaskDeliveryPolicy, DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { jsonValuesEqual } from "#shared/json.js";
import type { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

export type SessionControl = "clear" | "compact" | "expired" | "reset";

type TaskCohorts = ReturnType<typeof getSessionTaskCohorts>;

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
 * deterministically on replay. Handoff carries cancellation decisions so
 * late reports cannot wake a successor owner either.
 */
export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private readonly cancelledTaskIds: Set<string>;
  private readonly seenTaskDeliveryIds = new Set<string>();
  private nextSequence = 0;

  constructor(cancelledTaskIds: readonly string[] = []) {
    this.cancelledTaskIds = new Set(cancelledTaskIds);
  }

  getCancelledTaskIds(): readonly string[] {
    return [...this.cancelledTaskIds];
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  /** Cancellation discards model notifications, but admits task lifecycle effects. */
  enqueueDelivery(delivery: DeliverHookPayload): DeliveryAdmission | undefined {
    const deliveryId = taskDeliveryId(delivery);
    if (deliveryId !== undefined) {
      const terminalId = terminalTaskId(delivery);
      // Competing outcomes for one task must not produce separate cohort reports.
      const deduplicationId = terminalId === undefined ? deliveryId : `${terminalId}:ready`;
      if (
        this.seenTaskDeliveryIds.has(deduplicationId) ||
        (this.isCancelledTaskDelivery(deliveryId) && !hasTaskLifecycleData(delivery))
      ) {
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
        entry.kind === "delivery" && hasTaskLifecycleData(entry.delivery),
    );
  }

  replaceDelivery(sequence: number, delivery: DeliverHookPayload | undefined): void {
    const index = this.entries.findIndex(
      (entry) => entry.kind === "delivery" && entry.sequence === sequence,
    );
    if (index < 0) return;
    if (
      delivery === undefined ||
      (this.isCancelledDelivery(delivery) && !hasTaskLifecycleData(delivery))
    ) {
      this.entries.splice(index, 1);
      return;
    }
    this.entries[index] = { delivery, kind: "delivery", sequence };
  }

  /** Revokes model wakeups while preserving lifecycle effects for routing. */
  cancelTask(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    this.retain(
      (entry) =>
        entry.kind !== "delivery" ||
        !this.isCancelledDelivery(entry.delivery) ||
        hasTaskLifecycleData(entry.delivery),
    );
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
    cohorts: TaskCohorts,
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
    const index = this.nextActionableIndex(
      cohorts,
      options?.deferDeliveries === true,
      options?.taskDeliveryPolicy ?? "cohort",
    );
    if (index < 0) return undefined;
    return this.takeSelectionAt(index, cohorts, options?.freshSequence);
  }

  private nextActionableIndex(
    cohorts: TaskCohorts,
    deferDeliveries: boolean,
    taskDeliveryPolicy: TaskDeliveryPolicy,
  ): number {
    const pendingCohorts = new Set<string>();
    for (const [taskId, cohortId] of cohorts) {
      // A control step can record cancellation before its notification is admitted.
      // Wait for that notification too, so it cannot trigger a second cohort report.
      if (!this.seenTaskDeliveryIds.has(`${taskId}:ready`) && !this.cancelledTaskIds.has(taskId)) {
        pendingCohorts.add(cohortId);
      }
    }
    return this.entries.findIndex((entry) => {
      if (entry.kind === "control") return true;
      if (entry.kind === "authorization" || deferDeliveries) return false;
      if (this.isCancelledDelivery(entry.delivery)) return false;
      const cohort = terminalCohort(entry.delivery, cohorts);
      return taskDeliveryPolicy === "auto" || cohort === undefined || !pendingCohorts.has(cohort);
    });
  }

  private takeSelectionAt(
    index: number,
    cohorts: TaskCohorts,
    freshSequence: number | undefined,
  ): SessionInputSelection {
    const selected = this.entries[index]!;
    if (selected.kind !== "delivery") {
      this.entries.splice(index, 1);
      if (selected.kind === "control") return { control: selected.control, kind: "control" };
      return { kind: "authorization-resume", payloads: [selected.payload] };
    }
    const readyCohort = terminalCohort(selected.delivery, cohorts);
    if (readyCohort !== undefined) {
      const lastSibling = this.entries.findLastIndex(
        (entry) =>
          entry.kind === "delivery" &&
          !this.isCancelledDelivery(entry.delivery) &&
          terminalCohort(entry.delivery, cohorts) === readyCohort,
      );
      const boundary = this.entries.findIndex(
        (entry, position) =>
          position > index &&
          position < lastSibling &&
          (entry.kind !== "delivery" ||
            (!this.isCancelledDelivery(entry.delivery) &&
              terminalCohort(entry.delivery, cohorts) === undefined)),
      );
      if (boundary >= 0) return this.takeSelectionAt(boundary, cohorts, freshSequence);
    }

    const first = this.entries.splice(index, 1)[0]!;
    if (first.kind !== "delivery") throw new Error("Selected a non-delivery entry as a turn.");
    const turnEntries = [first];
    const cohort = terminalCohort(first.delivery, cohorts);
    if (cohort !== undefined) {
      const siblings = this.entries.filter(
        (entry): entry is QueuedDelivery =>
          entry.kind === "delivery" &&
          !this.isCancelledDelivery(entry.delivery) &&
          terminalCohort(entry.delivery, cohorts) === cohort,
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

  private isCancelledTaskDelivery(deliveryId: string): boolean {
    for (const taskId of this.cancelledTaskIds) {
      if (deliveryId === taskId || deliveryId.startsWith(`${taskId}:`)) return true;
    }
    return false;
  }

  private isCancelledDelivery(delivery: DeliverHookPayload): boolean {
    return isTaskDelivery(delivery, (id) => this.isCancelledTaskDelivery(id));
  }

  private retain(predicate: (entry: QueuedSessionInput) => boolean): void {
    const kept = this.entries.filter(predicate);
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

function hasTaskLifecycleData(delivery: DeliverHookPayload): boolean {
  return delivery.payloads.some((payload) => payload.task !== undefined);
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

function isTaskDelivery(
  delivery: DeliverHookPayload,
  predicate: (deliveryId: string) => boolean,
): boolean {
  const deliveryId = taskDeliveryId(delivery);
  return deliveryId !== undefined && predicate(deliveryId);
}

function terminalCohort(delivery: DeliverHookPayload, cohorts: TaskCohorts): string | undefined {
  const taskId = terminalTaskId(delivery);
  return taskId === undefined ? undefined : cohorts.get(taskId);
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
