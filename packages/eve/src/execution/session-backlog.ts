import type { DeliverHookPayload } from "#channel/types.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { jsonValuesEqual } from "#shared/json.js";
import type { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

export type SessionControl = "clear" | "compact" | "expired" | "reset";

type TaskCohorts = ReturnType<typeof getSessionTaskCohorts>;

/**
 * Accepted session input that has not yet become a turn. The inbox holds
 * payloads until a committed boundary; the backlog holds them from that
 * boundary until turn policy selects them. Handoff eligibility requires it
 * to be empty.
 */
export class SessionBacklog {
  readonly deliveries: DeliverHookPayload[] = [];
  readonly controls: SessionControl[] = [];
  private readonly cancelledTaskIds = new Set<string>();
  private readonly seenTaskDeliveries = new Set<string>();

  isEmpty(): boolean {
    return this.deliveries.length === 0 && this.controls.length === 0;
  }

  markTaskSeen(taskId: string): void {
    this.seenTaskDeliveries.add(taskId);
  }

  /** Accepts a delivery once per task delivery id; rejects cancelled-task deliveries. */
  accept(delivery: DeliverHookPayload): boolean {
    const deliveryId = taskDeliveryId(delivery);
    if (deliveryId !== undefined) {
      if (this.isCancelledTask(deliveryId) || this.seenTaskDeliveries.has(deliveryId)) return false;
      this.seenTaskDeliveries.add(deliveryId);
    }
    return true;
  }

  discardTask(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    this.retain((delivery) => !this.isCancelledTaskDelivery(delivery));
  }

  takeControl(): SessionControl | undefined {
    return this.controls.shift();
  }

  /**
   * Removes and coalesces every buffered delivery eligible to steer the active
   * turn: admitted during this turn, not a task notification, `steer` policy,
   * and either callerless or from the turn's own caller.
   */
  takeSteering(
    admitted: ReadonlySet<DeliverHookPayload>,
    callerCallId: string | undefined,
  ): DeliverHookPayload | undefined {
    const steering = this.deliveries.filter(
      (delivery) =>
        admitted.has(delivery) &&
        delivery.taskDeliveryId === undefined &&
        (delivery.turnPolicy ?? "steer") === "steer" &&
        (delivery.caller === undefined || delivery.caller.callId === callerCallId),
    );
    if (steering.length === 0) return undefined;
    this.retain((delivery) => !steering.includes(delivery));
    return coalesceDeliveries(steering);
  }

  /**
   * Removes and coalesces the next parked turn. Sibling task completions in one
   * cohort batch into a single turn once every sibling has reported; adjacent
   * ordinary deliveries from the same authenticated principal batch together.
   */
  takeTurn(cohorts: TaskCohorts): DeliverHookPayload | undefined {
    this.retain((delivery) => !this.isCancelledTaskDelivery(delivery));
    const deliveries = this.deliveries;

    const completed = new Set(
      deliveries.flatMap((delivery) => {
        const taskId = completionTaskId(delivery);
        return taskId === undefined ? [] : [taskId];
      }),
    );
    const pendingCohorts = new Set<string>();
    for (const [taskId, cohort] of cohorts) {
      if (!cohort.settled && !completed.has(taskId) && !this.cancelledTaskIds.has(taskId)) {
        pendingCohorts.add(cohort.cohortId);
      }
    }
    let index = deliveries.findIndex((delivery) => {
      const cohort = completionCohort(delivery, cohorts);
      return cohort === undefined || !pendingCohorts.has(cohort);
    });
    if (index < 0) return undefined;
    const readyCohort = completionCohort(deliveries[index]!, cohorts);
    if (readyCohort !== undefined) {
      const lastSibling = deliveries.findLastIndex(
        (delivery) => completionCohort(delivery, cohorts) === readyCohort,
      );
      // Settlement must apply before terminal views release its claimed handle.
      // Process intervening deliveries first, then re-evaluate the cohort.
      const boundary = deliveries.findIndex(
        (delivery, position) =>
          position > index &&
          position < lastSibling &&
          completionCohort(delivery, cohorts) === undefined,
      );
      if (boundary >= 0) index = boundary;
    }
    const first = deliveries.splice(index, 1)[0]!;
    const cohort = completionCohort(first, cohorts);
    if (cohort !== undefined) {
      const siblings = deliveries.filter(
        (delivery) => completionCohort(delivery, cohorts) === cohort,
      );
      this.retain((delivery) => completionCohort(delivery, cohorts) !== cohort);
      return coalesceDeliveries([first, ...siblings]);
    }

    const authenticated = first.auth != null && first.auth.principalType !== "anonymous";
    const turnDeliveries = [first];
    let caller = first.caller;
    while (deliveries.length > index) {
      const next = deliveries[index];
      if (
        next === undefined ||
        first.taskDeliveryId !== undefined ||
        next.taskDeliveryId !== undefined ||
        !authenticated ||
        !jsonValuesEqual(first.auth, next.auth) ||
        (caller !== undefined && next.caller !== undefined)
      ) {
        break;
      }
      turnDeliveries.push(deliveries.splice(index, 1)[0]!);
      caller ??= next.caller;
    }
    return coalesceDeliveries(turnDeliveries);
  }

  private retain(predicate: (delivery: DeliverHookPayload) => boolean): void {
    const kept = this.deliveries.filter(predicate);
    this.deliveries.splice(0, this.deliveries.length, ...kept);
  }

  private isCancelledTaskDelivery(delivery: DeliverHookPayload): boolean {
    const deliveryId = taskDeliveryId(delivery);
    return deliveryId !== undefined && this.isCancelledTask(deliveryId);
  }

  private isCancelledTask(deliveryId: string): boolean {
    for (const taskId of this.cancelledTaskIds) {
      if (deliveryId === taskId || deliveryId.startsWith(`${taskId}:`)) return true;
    }
    return false;
  }
}

function taskDeliveryId(delivery: DeliverHookPayload): string | undefined {
  return delivery.taskDeliveryId ?? delivery.caller?.taskId;
}

/** Only successful sibling notifications can share their existing cohort context. */
function completionCohort(delivery: DeliverHookPayload, cohorts: TaskCohorts): string | undefined {
  const taskId = completionTaskId(delivery);
  return taskId === undefined ? undefined : cohorts.get(taskId)?.cohortId;
}

function completionTaskId(delivery: DeliverHookPayload): string | undefined {
  const suffix = ":ready:completed";
  if (delivery.caller !== undefined || !delivery.taskDeliveryId?.endsWith(suffix)) return undefined;
  return delivery.taskDeliveryId.slice(0, -suffix.length);
}
