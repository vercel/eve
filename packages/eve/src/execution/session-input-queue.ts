import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import {
  createSessionDeliveryHook,
  type SessionDeliveryHookHandle,
} from "#execution/session-delivery-hook.js";
import { coalesceDeliveries } from "#harness/messages.js";

/** Owns public hook admission and ordered input buffered by one session driver. */
export interface SessionInputQueue {
  appendQueued(delivery: DeliverHookPayload): void;
  consumeAdmission(): void;
  dispose(): Promise<void>;
  nextAdmission(): Promise<IteratorResult<HookPayload>>;
  prependReturned(delivery: DeliverHookPayload): void;
  prependTurnRemainders(deliveries: readonly DeliverHookPayload[]): void;
  rekey(token: string): Promise<void>;
  returnSteering(delivery: DeliverHookPayload): void;
  takeExplicitResponse(): DeliverHookPayload | undefined;
  takeNextTurn(): Promise<DeliverHookPayload | null>;
}

/** Creates the single owner of a session driver's live and buffered input. */
export function createSessionInputQueue(): SessionInputQueue {
  const buffered: DeliverHookPayload[] = [];
  const deliveryHook = createSessionDeliveryHook((delivery) =>
    buffered.push(asQueuedDelivery(delivery)),
  );

  return createQueue(deliveryHook, buffered);
}

function createQueue(
  deliveryHook: SessionDeliveryHookHandle,
  buffered: DeliverHookPayload[],
): SessionInputQueue {
  return {
    appendQueued(delivery): void {
      if (delivery.turnPolicy === "steer") {
        throw new Error("Steering input must use returnSteering() before entering the queue.");
      }
      buffered.push(delivery);
    },
    consumeAdmission: () => deliveryHook.consumeNext(),
    dispose: () => deliveryHook.dispose(),
    nextAdmission: () => deliveryHook.next(),
    prependReturned(delivery): void {
      buffered.unshift(asQueuedDelivery(delivery));
    },
    prependTurnRemainders(deliveries): void {
      buffered.unshift(...deliveries.map(asQueuedDelivery));
    },
    rekey: (token) => deliveryHook.rekey(token),
    returnSteering(delivery): void {
      buffered.push(asQueuedDelivery(delivery));
    },
    takeExplicitResponse(): DeliverHookPayload | undefined {
      const index = buffered.findIndex((delivery) =>
        delivery.payloads.some((payload) => (payload.inputResponses?.length ?? 0) > 0),
      );
      if (index < 0) return undefined;
      return buffered.splice(index, 1)[0];
    },
    async takeNextTurn(): Promise<DeliverHookPayload | null> {
      if (buffered.length > 0) {
        return coalesceDeliveries(buffered.splice(0));
      }

      while (true) {
        const first = await deliveryHook.next();
        deliveryHook.consumeNext();

        if (first.done) return null;
        if (first.value.kind !== "deliver") continue;

        let coalesced = asQueuedDelivery(first.value);
        while (true) {
          const ready = await takeReadyPayload(deliveryHook.next());
          if (ready === NO_READY_MESSAGE) break;

          deliveryHook.consumeNext();
          if (ready.done) break;
          if (ready.value.kind !== "deliver") continue;
          coalesced = coalesceDeliveries([coalesced, asQueuedDelivery(ready.value)]);
        }
        return coalesced;
      }
    },
  };
}

function asQueuedDelivery(delivery: DeliverHookPayload): DeliverHookPayload {
  return delivery.turnPolicy === "steer" ? { ...delivery, turnPolicy: "queue" } : delivery;
}

const NO_READY_MESSAGE = Symbol("no-ready-message");

async function takeReadyPayload<T>(promise: Promise<T>): Promise<T | typeof NO_READY_MESSAGE> {
  await Promise.resolve();
  return await Promise.race([promise, Promise.resolve(NO_READY_MESSAGE)]);
}
