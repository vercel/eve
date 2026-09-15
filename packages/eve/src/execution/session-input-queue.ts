import type { DeliverHookPayload } from "#channel/types.js";
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

type QueuedSessionInput = QueuedDelivery | QueuedControl;

export interface TurnInputProvenance {
  readonly admissions: readonly DeliveryAdmission[];
  readonly source: "conversation" | "task";
}

export interface TurnSelection {
  readonly delivery: DeliverHookPayload;
  /** Only a fresh parked-inbox admission may request a deployment handoff. */
  readonly handoffEligible?: boolean;
  readonly kind: "turn";
  readonly provenance: TurnInputProvenance;
}

export type SessionInputSelection =
  | TurnSelection
  | { readonly control: SessionControl; readonly kind: "control" };

/**
 * Ordered, admitted session input. Entries are private; callers receive typed
 * admission and selection values instead of mutating transport-shaped arrays.
 */
export class SessionInputQueue {
  private readonly entries: QueuedSessionInput[] = [];
  private nextSequence = 0;

  get pendingCount(): number {
    return this.entries.length;
  }

  enqueueDelivery(delivery: DeliverHookPayload): DeliveryAdmission {
    const admission = { delivery, sequence: this.nextSequence++ };
    this.entries.push({ ...admission, kind: "delivery" });
    return admission;
  }

  enqueueControl(control: SessionControl): void {
    this.entries.push({ control, kind: "control", sequence: this.nextSequence++ });
  }

  delivery(sequence: number): DeliverHookPayload | undefined {
    const entry = this.entries.find(
      (candidate): candidate is QueuedDelivery =>
        candidate.kind === "delivery" && candidate.sequence === sequence,
    );
    return entry?.delivery;
  }

  replaceDelivery(sequence: number, delivery: DeliverHookPayload | undefined): void {
    const index = this.entries.findIndex(
      (entry) => entry.kind === "delivery" && entry.sequence === sequence,
    );
    if (index < 0) return;
    if (delivery === undefined) {
      this.entries.splice(index, 1);
      return;
    }
    this.entries[index] = { delivery, kind: "delivery", sequence };
  }

  discardTask(taskId: string): void {
    this.retain(
      (entry) =>
        entry.kind === "control" ||
        !isTaskDelivery(entry.delivery, (id) => id === taskId || id.startsWith(`${taskId}:`)),
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
        entry.delivery.taskDeliveryId === undefined &&
        (entry.delivery.turnPolicy ?? "steer") === "steer" &&
        (entry.delivery.caller === undefined || entry.delivery.caller.callId === callerCallId),
    );
    if (steering.length === 0) return undefined;
    this.retain((entry) => entry.kind === "control" || !steering.includes(entry));
    const admissions = steering.map(({ delivery, sequence }) => ({ delivery, sequence }));
    return {
      delivery: combine(steering),
      kind: "turn",
      provenance: { admissions, source: "conversation" },
    };
  }

  takeNext(
    cohorts: TaskCohorts,
    options?: {
      readonly deferDeliveries?: boolean;
      readonly isTaskCancelled?: (taskId: string) => boolean;
    },
  ): SessionInputSelection | undefined {
    const index = this.nextActionableIndex(
      cohorts,
      options?.deferDeliveries === true,
      options?.isTaskCancelled,
    );
    if (index < 0) return undefined;
    return this.takeSelectionAt(index, cohorts);
  }

  private nextActionableIndex(
    cohorts: TaskCohorts,
    deferDeliveries: boolean,
    isTaskCancelled: ((taskId: string) => boolean) | undefined,
  ): number {
    const deliveries = this.entries.filter(
      (entry): entry is QueuedDelivery => entry.kind === "delivery",
    );
    const completed = new Set(
      deliveries.flatMap(({ delivery }) => {
        const taskId = completionTaskId(delivery);
        return taskId === undefined ? [] : [taskId];
      }),
    );
    const pendingCohorts = new Set<string>();
    for (const [taskId, cohort] of cohorts) {
      if (!cohort.settled && !completed.has(taskId) && isTaskCancelled?.(taskId) !== true) {
        pendingCohorts.add(cohort.cohortId);
      }
    }
    return this.entries.findIndex((entry) => {
      if (entry.kind === "control") return true;
      if (deferDeliveries) return false;
      const cohort = completionCohort(entry.delivery, cohorts);
      return cohort === undefined || !pendingCohorts.has(cohort);
    });
  }

  private takeSelectionAt(index: number, cohorts: TaskCohorts): SessionInputSelection {
    const selected = this.entries[index]!;
    if (selected.kind === "control") {
      this.entries.splice(index, 1);
      return { control: selected.control, kind: "control" };
    }
    const readyCohort = completionCohort(selected.delivery, cohorts);
    if (readyCohort !== undefined) {
      const lastSibling = this.entries.findLastIndex(
        (entry) =>
          entry.kind === "delivery" && completionCohort(entry.delivery, cohorts) === readyCohort,
      );
      const boundary = this.entries.findIndex(
        (entry, position) =>
          position > index &&
          position < lastSibling &&
          (entry.kind === "control" || completionCohort(entry.delivery, cohorts) === undefined),
      );
      if (boundary >= 0) return this.takeSelectionAt(boundary, cohorts);
    }

    const first = this.entries.splice(index, 1)[0]!;
    if (first.kind === "control") return { control: first.control, kind: "control" };
    const turnEntries = [first];
    const cohort = completionCohort(first.delivery, cohorts);
    if (cohort !== undefined) {
      const siblings = this.entries.filter(
        (entry): entry is QueuedDelivery =>
          entry.kind === "delivery" && completionCohort(entry.delivery, cohorts) === cohort,
      );
      turnEntries.push(...siblings);
      this.retain((entry) =>
        entry.kind === "control" ? true : completionCohort(entry.delivery, cohorts) !== cohort,
      );
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

    const admissions = turnEntries.map(({ delivery, sequence }) => ({ delivery, sequence }));
    const source = turnEntries.some(({ delivery }) => taskDeliveryId(delivery) !== undefined)
      ? "task"
      : "conversation";
    return {
      delivery: combine(turnEntries),
      kind: "turn",
      provenance: { admissions, source },
    };
  }

  private retain(predicate: (entry: QueuedSessionInput) => boolean): void {
    const kept = this.entries.filter(predicate);
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

function combine(entries: readonly DeliveryAdmission[]): DeliverHookPayload {
  return entries.length === 1
    ? entries[0]!.delivery
    : coalesceDeliveries(entries.map(({ delivery }) => delivery));
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

function completionCohort(delivery: DeliverHookPayload, cohorts: TaskCohorts): string | undefined {
  const taskId = completionTaskId(delivery);
  return taskId === undefined ? undefined : cohorts.get(taskId)?.cohortId;
}

function completionTaskId(delivery: DeliverHookPayload): string | undefined {
  const suffix = ":ready:completed";
  if (delivery.caller !== undefined || !delivery.taskDeliveryId?.endsWith(suffix)) return undefined;
  return delivery.taskDeliveryId.slice(0, -suffix.length);
}
