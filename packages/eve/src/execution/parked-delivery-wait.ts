import type { DeliverHookPayload, DeliverPayload, SessionCommand } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { coalesceDeliveries } from "#harness/messages.js";

type NextSessionAction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | {
      readonly delivery: DeliverHookPayload | null;
      readonly kind: "delivery";
    };

/** What the parked driver should do with the next session activity. */
type NextTurnOutcome =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "turn";
      readonly deliver: DeliverHookPayload;
      readonly remainder: DeliverPayload;
      readonly sessionState: DurableSessionState;
    };

export type NextTurnInstruction = NextTurnOutcome & {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
};

/**
 * Awaits the next delivery that requires driver action while the session
 * is parked. Deliveries fully routed to a descendant leave the parent with
 * no turn to run, so this keeps waiting until a delivery produces a parent
 * turn, a cancellation, expiry, or hook closure. The wait is unbounded by
 * design: a parked session lives until something addresses it.
 */
export async function nextTurnDelivery(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds?: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly seenTaskDeliveries?: Set<string>;
  readonly sessionState: DurableSessionState;
}): Promise<NextTurnInstruction> {
  let sessionState = input.sessionState;
  let serializedContext = input.serializedContext;
  const cancelledTaskIds = input.cancelledTaskIds ?? new Set<string>();
  const seenTaskDeliveries = input.seenTaskDeliveries ?? new Set<string>();
  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      bufferedSessionControls: input.bufferedSessionControls,
      cancelledTaskIds,
      commandInbox: input.commandInbox,
      seenTaskDeliveries,
    });

    if (nextAction.kind !== "delivery") {
      return { kind: nextAction.kind, serializedContext, sessionState };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed", serializedContext, sessionState };
    }

    const routed = await routeDeliverToChildren({
      auth: deliver.auth,
      parentWritable: input.driverWritable,
      payloads: deliver.payloads,
      serializedContext,
      sessionState,
    });
    serializedContext = routed.serializedContext ?? serializedContext;
    sessionState = routed.sessionState ?? sessionState;

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn", serializedContext, sessionState };
    }

    if (routed.remainder === undefined) {
      // Fully routed to a descendant; keep waiting.
      continue;
    }

    return {
      deliver,
      kind: "turn",
      remainder: routed.remainder,
      serializedContext,
      sessionState,
    };
  }
}

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly seenTaskDeliveries: Set<string>;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
  }

  while (
    input.bufferedDeliveries[0] !== undefined &&
    isCancelledTaskDelivery(input.bufferedDeliveries[0], input.cancelledTaskIds)
  ) {
    input.bufferedDeliveries.shift();
  }
  if (input.bufferedDeliveries.length > 0) {
    return {
      delivery: takeBufferedTurnDelivery(input.bufferedDeliveries),
      kind: "delivery",
    };
  }

  while (true) {
    const first = await input.commandInbox.next();
    input.commandInbox.consumeNext();

    if (first.done) {
      return { delivery: null, kind: "delivery" };
    }

    if (first.value.kind === "session-timeout") {
      return { kind: "expired" };
    }

    if (
      first.value.kind === "clear" ||
      first.value.kind === "compact" ||
      first.value.kind === "reset"
    ) {
      return { kind: first.value.kind };
    }

    if (first.value.kind === "cancel") {
      if (first.value.taskId !== undefined) {
        input.cancelledTaskIds.add(first.value.taskId);
        const kept = input.bufferedDeliveries.filter(
          (delivery) => !isCancelledTaskDelivery(delivery, input.cancelledTaskIds),
        );
        input.bufferedDeliveries.splice(0, input.bufferedDeliveries.length, ...kept);
      }
      continue;
    }

    const deliveryId = first.value.taskDeliveryId ?? first.value.caller?.taskId;
    if (deliveryId !== undefined && isCancelledTaskDeliveryId(deliveryId, input.cancelledTaskIds)) {
      continue;
    }
    if (deliveryId !== undefined) {
      if (input.seenTaskDeliveries.has(deliveryId)) continue;
      input.seenTaskDeliveries.add(deliveryId);
    }
    return { delivery: commandToDelivery(first.value), kind: "delivery" };
  }
}

function commandToDelivery(
  command: Extract<SessionCommand, { readonly kind: "send" }>,
): DeliverHookPayload {
  return {
    auth: command.auth,
    caller: command.caller,
    kind: "deliver",
    payloads: [command.payload],
    requestId: command.requestId,
    taskDeliveryId: command.taskDeliveryId,
  };
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

function takeBufferedTurnDelivery(bufferedDeliveries: DeliverHookPayload[]): DeliverHookPayload {
  const first = bufferedDeliveries.shift();
  if (first === undefined) {
    throw new Error("Cannot take a turn delivery from an empty buffer.");
  }

  const turnDeliveries = [first];
  let caller = first.caller;
  while (bufferedDeliveries.length > 0) {
    const next = bufferedDeliveries[0];
    if (
      next === undefined ||
      first.taskDeliveryId !== undefined ||
      next.taskDeliveryId !== undefined ||
      (caller !== undefined && next.caller !== undefined)
    ) {
      break;
    }

    const delivery = bufferedDeliveries.shift();
    if (delivery === undefined) {
      throw new Error("Buffered turn delivery disappeared while partitioning.");
    }
    turnDeliveries.push(delivery);
    caller ??= delivery.caller;
  }

  return coalesceDeliveries(turnDeliveries);
}
