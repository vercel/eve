import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import { filterAwaitedTaskWakePayloadsStep } from "#execution/tasks/wake-suppression-step.js";
import { coalesceDeliveries } from "#harness/messages.js";

type NextSessionAction =
  | {
      readonly delivery: DeliverHookPayload | null;
      readonly kind: "delivery";
    }
  | { readonly kind: "expired" };

/** What the parked driver should do with the next session activity. */
export type NextTurnInstruction =
  | { readonly kind: "expired" }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "turn";
      readonly deliver: DeliverHookPayload;
      readonly remainder: DeliverPayload;
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
  readonly deliveryHook: SessionDeliveryHook;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextTurnInstruction> {
  let sessionState = input.sessionState;
  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      deliveryHook: input.deliveryHook,
    });

    if (nextAction.kind === "expired") {
      return { kind: "expired" };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed" };
    }

    const filtered = await filterAwaitedTaskWakePayloadsStep({
      payloads: deliver.payloads,
      serializedContext: input.serializedContext,
      sessionState,
    });
    sessionState = filtered.sessionState;
    if (filtered.payloads.length === 0) {
      // A completed task_await already reported every task in this delivery.
      continue;
    }

    const routed = await routeDeliverToChildren({
      auth: deliver.auth,
      parentWritable: input.driverWritable,
      payloads: filtered.payloads,
      sessionState,
    });

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn" };
    }

    if (routed.remainder === undefined) {
      // Fully routed to a descendant; keep waiting.
      continue;
    }

    return { deliver, kind: "turn", remainder: routed.remainder, sessionState };
  }
}

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly deliveryHook: SessionDeliveryHook;
}): Promise<NextSessionAction> {
  if (input.deliveryHook.consumeSessionTimeout()) {
    return { kind: "expired" };
  }

  if (input.bufferedDeliveries.length > 0) {
    return {
      delivery: takeBufferedTurnDelivery(input.bufferedDeliveries),
      kind: "delivery",
    };
  }

  while (true) {
    const first = await input.deliveryHook.next();
    input.deliveryHook.consumeNext();

    if (first.done) {
      return { delivery: null, kind: "delivery" };
    }

    if (first.value.kind === "session-timeout") {
      return { kind: "expired" };
    }

    if (first.value.kind !== "deliver") {
      continue;
    }

    let coalesced = first.value;

    while (true) {
      const ready = await takeReadyPayload(input.deliveryHook.next());

      if (ready === NO_READY_MESSAGE) {
        break;
      }

      if (ready.done) {
        input.deliveryHook.consumeNext();
        break;
      }

      // Preserve a timeout queued after a delivery. The delivery committed
      // first, so its active turn settles before the offered timeout is read.
      if (ready.value.kind === "session-timeout") {
        break;
      }

      if (
        ready.value.kind === "deliver" &&
        coalesced.caller !== undefined &&
        ready.value.caller !== undefined
      ) {
        // Leave the offered delivery unconsumed for the next turn.
        break;
      }

      input.deliveryHook.consumeNext();

      if (ready.value.kind !== "deliver") {
        continue;
      }

      coalesced = coalesceDeliveries([coalesced, ready.value]);
    }

    return { delivery: coalesced, kind: "delivery" };
  }
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
    if (next === undefined || (caller !== undefined && next.caller !== undefined)) {
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
const NO_READY_MESSAGE = Symbol("no-ready-message");

async function takeReadyPayload<T>(promise: Promise<T>): Promise<T | typeof NO_READY_MESSAGE> {
  await Promise.resolve();
  return await Promise.race([promise, Promise.resolve(NO_READY_MESSAGE)]);
}
