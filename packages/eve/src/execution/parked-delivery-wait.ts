import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { jsonValuesEqual } from "#shared/json.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import {
  sessionInboxWire,
  SessionInboxWireError,
  type DecodedSessionInbox,
} from "#execution/wire/session-inbox-wire.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

type NextSessionAction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | AuthorizationCallbackInstruction
  | {
      readonly delivery: DeliverHookPayload | null;
      readonly kind: "delivery";
    };

/** One authorization-callback read surfaced during a parked wait. */
export interface AuthorizationCallbackInstruction {
  readonly kind: "authorization";
  /** True when the authorization hook closed; no further callbacks can arrive. */
  readonly closed: boolean;
  readonly payloads: readonly DeliverPayload[];
}

/** What the parked driver should do with the next session activity. */
export type NextTurnInstruction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | AuthorizationCallbackInstruction
  | {
      readonly kind: "turn";
      readonly delivery: DeliverHookPayload;
    };

/**
 * Awaits the next delivery that requires driver action while the session
 * is parked. Deliveries fully routed to a descendant leave the parent with
 * no turn to run, so this keeps waiting until a delivery produces a parent
 * turn, a cancellation, expiry, or hook closure. The wait is unbounded by
 * design: a parked session lives until something addresses it.
 *
 * With `awaitAuthorizationCallbacks`, the inbox's authorization window stays
 * open for the whole wait — including iterations that consume activity
 * without producing a parent turn (no-op cancels, fully-routed descendant
 * deliveries) — so an open challenge's callback surfaces as an
 * `"authorization"` instruction no matter when it arrives.
 *
 * Routing steps mutate durable state; each transition is adopted into the
 * caller-owned `stateCursor`, so returns carry only the instruction kind.
 */
export async function nextTurnDelivery(input: {
  readonly awaitAuthorizationCallbacks?: boolean;
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds?: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly seenTaskDeliveries?: Set<string>;
  readonly stateCursor: SessionStateCursor;
}): Promise<NextTurnInstruction> {
  if (input.awaitAuthorizationCallbacks !== true) {
    return await awaitNextTurnDelivery(input);
  }

  input.commandInbox.setAuthorizationWindow(true);
  try {
    return await awaitNextTurnDelivery(input);
  } finally {
    input.commandInbox.setAuthorizationWindow(false);
  }
}

async function awaitNextTurnDelivery(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds?: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly seenTaskDeliveries?: Set<string>;
  readonly stateCursor: SessionStateCursor;
}): Promise<NextTurnInstruction> {
  const cancelledTaskIds = input.cancelledTaskIds ?? new Set<string>();
  const seenTaskDeliveries = input.seenTaskDeliveries ?? new Set<string>();
  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      bufferedSessionControls: input.bufferedSessionControls,
      cancelledTaskIds,
      commandInbox: input.commandInbox,
      deferDeliveries: input.deferDeliveries,
      seenTaskDeliveries,
      stateCursor: input.stateCursor,
    });

    if (nextAction.kind === "authorization") {
      return nextAction;
    }

    if (nextAction.kind !== "delivery") {
      return { kind: nextAction.kind };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed" };
    }

    const routed = await routeDeliverToChildren({
      delivery: deliver,
      parentWritable: input.driverWritable,
      serializedContext: input.stateCursor.serializedContext,
      sessionState: input.stateCursor.sessionState,
    });
    input.stateCursor.adoptState(routed);

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn" };
    }

    if (routed.remainder === undefined) {
      // Fully routed to a descendant; keep waiting.
      continue;
    }

    return { delivery: routed.remainder, kind: "turn" };
  }
}

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly seenTaskDeliveries: Set<string>;
  readonly stateCursor: SessionStateCursor;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
  }

  while (true) {
    if (input.deferDeliveries !== true && !input.commandInbox.hasReadyAuthorization()) {
      const delivery = takeBufferedTurnDelivery(
        input.bufferedDeliveries,
        getSessionTaskCohorts(input.stateCursor.sessionState.snapshot?.session.state),
        input.cancelledTaskIds,
      );
      if (delivery !== undefined) return { delivery, kind: "delivery" };
    }

    const { result: first, source } = await input.commandInbox.nextWithSource();
    input.commandInbox.consumeNext();

    if (source === "authorization") {
      if (first.done) {
        return { closed: true, kind: "authorization", payloads: [] };
      }
      return {
        closed: false,
        kind: "authorization",
        payloads: first.value.kind === "deliver" ? first.value.payloads : [],
      };
    }

    if (first.done) {
      return { delivery: null, kind: "delivery" };
    }

    // Runtime-action results use the active turn's private inbox. A late value
    // can still surface through an old session alias, where the driver has
    // always ignored it rather than treating it as a session command.
    if (first.value.kind === "runtime-action-result") {
      continue;
    }

    let decoded: DecodedSessionInbox;
    try {
      decoded = sessionInboxWire.decode(first.value);
    } catch (error) {
      if (!(error instanceof SessionInboxWireError)) throw error;
      // A lost delivery with an operator-visible signal is the designed
      // failure; reinterpreting an unknown payload is the bug. Stay parked.
      await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
      continue;
    }

    if (decoded.kind === "session-timeout") {
      return { kind: "expired" };
    }

    if (decoded.kind === "clear" || decoded.kind === "compact" || decoded.kind === "reset") {
      return { kind: decoded.kind };
    }

    if (decoded.kind === "cancel") {
      if ("tasks" in decoded && decoded.tasks === true) {
        await cancelAllIndexedSessionTasksStep({
          serializedContext: input.stateCursor.serializedContext,
          sessionState: input.stateCursor.sessionState,
        });
      }
      if (decoded.taskId !== undefined) {
        input.cancelledTaskIds.add(decoded.taskId);
        const kept = input.bufferedDeliveries.filter(
          (delivery) => !isCancelledTaskDelivery(delivery, input.cancelledTaskIds),
        );
        input.bufferedDeliveries.splice(0, input.bufferedDeliveries.length, ...kept);
      }
      continue;
    }

    const deliveryId = decoded.taskDeliveryId ?? decoded.caller?.taskId;
    if (deliveryId !== undefined && isCancelledTaskDeliveryId(deliveryId, input.cancelledTaskIds)) {
      continue;
    }
    if (deliveryId !== undefined) {
      if (input.seenTaskDeliveries.has(deliveryId)) continue;
      input.seenTaskDeliveries.add(deliveryId);
    }

    input.bufferedDeliveries.push(decoded);
  }
}

function isCancelledTaskDelivery(
  delivery: DeliverHookPayload,
  cancelledTaskIds: ReadonlySet<string>,
): boolean {
  const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
  return deliveryId !== undefined && isCancelledTaskDeliveryId(deliveryId, cancelledTaskIds);
}

function isCancelledTaskDeliveryId(
  deliveryId: string,
  cancelledTaskIds: ReadonlySet<string>,
): boolean {
  return [...cancelledTaskIds].some(
    (taskId) => deliveryId === taskId || deliveryId.startsWith(`${taskId}:`),
  );
}

function takeBufferedTurnDelivery(
  bufferedDeliveries: DeliverHookPayload[],
  cohorts: ReturnType<typeof getSessionTaskCohorts>,
  cancelledTaskIds: ReadonlySet<string>,
): DeliverHookPayload | undefined {
  const retained = bufferedDeliveries.filter(
    (delivery) => !isCancelledTaskDelivery(delivery, cancelledTaskIds),
  );
  bufferedDeliveries.splice(0, bufferedDeliveries.length, ...retained);

  const completed = new Set(
    bufferedDeliveries.flatMap((delivery) => {
      const taskId = completionTaskId(delivery);
      return taskId === undefined ? [] : [taskId];
    }),
  );
  const pendingCohorts = new Set<string>();
  for (const [taskId, cohort] of cohorts) {
    if (!cohort.settled && !completed.has(taskId) && !cancelledTaskIds.has(taskId)) {
      pendingCohorts.add(cohort.turnId);
    }
  }
  const index = bufferedDeliveries.findIndex((delivery) => {
    const cohort = completionCohort(delivery, cohorts);
    return cohort === undefined || !pendingCohorts.has(cohort);
  });
  if (index < 0) return undefined;
  const first = bufferedDeliveries.splice(index, 1)[0]!;
  const cohort = completionCohort(first, cohorts);
  if (cohort !== undefined) {
    const siblings = bufferedDeliveries.filter(
      (delivery) => completionCohort(delivery, cohorts) === cohort,
    );
    const remaining = bufferedDeliveries.filter(
      (delivery) => completionCohort(delivery, cohorts) !== cohort,
    );
    bufferedDeliveries.splice(0, bufferedDeliveries.length, ...remaining);
    return coalesceDeliveries([first, ...siblings]);
  }

  const authenticated = first.auth != null && first.auth.principalType !== "anonymous";
  const turnDeliveries = [first];
  let caller = first.caller;
  while (bufferedDeliveries.length > index) {
    const next = bufferedDeliveries[index];
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

    const delivery = bufferedDeliveries.splice(index, 1)[0];
    if (delivery === undefined) {
      throw new Error("Buffered turn delivery disappeared while partitioning.");
    }
    turnDeliveries.push(delivery);
    caller ??= delivery.caller;
  }

  return coalesceDeliveries(turnDeliveries);
}

/** Only successful sibling notifications can share their existing cohort context. */
function completionCohort(
  delivery: DeliverHookPayload,
  cohorts: ReturnType<typeof getSessionTaskCohorts>,
): string | undefined {
  const taskId = completionTaskId(delivery);
  return taskId === undefined ? undefined : cohorts.get(taskId)?.turnId;
}

function completionTaskId(delivery: DeliverHookPayload): string | undefined {
  const suffix = ":ready:completed";
  if (delivery.caller !== undefined || !delivery.taskDeliveryId?.endsWith(suffix)) return undefined;
  return delivery.taskDeliveryId.slice(0, -suffix.length);
}
