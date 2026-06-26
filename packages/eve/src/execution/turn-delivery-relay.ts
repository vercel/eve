import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";

type DeliveryRequest = Extract<TurnCompletionPayload, { readonly kind: "turn-delivery-request" }>;

/** Relays one public session delivery requested by an active turn. */
export async function serviceTurnDeliveryRequest(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly consumeCompletion: () => void;
  readonly consumeNext: () => void;
  readonly getCompletionPromise: () => Promise<IteratorResult<TurnCompletionPayload>>;
  readonly getNextPromise: () => Promise<IteratorResult<HookPayload>>;
  readonly request: DeliveryRequest;
  readonly rekeyHook: (nextToken: string) => Promise<void>;
}): Promise<NextDriverAction | undefined> {
  await input.rekeyHook(input.request.continuationToken);

  let delivery = input.bufferedDeliveries.shift();
  while (delivery === undefined) {
    const winner = await Promise.race([
      input.getCompletionPromise().then((value) => ({ kind: "control" as const, value })),
      input.getNextPromise().then((value) => ({ kind: "delivery" as const, value })),
    ]);

    if (winner.kind === "control") {
      input.consumeCompletion();
      if (winner.value.done) {
        throw new Error("Turn completion hook closed during a delivery request.");
      }
      if (winner.value.value.kind === "turn-continuation-token") {
        await input.rekeyHook(winner.value.value.continuationToken);
        continue;
      }
      const terminal = readTerminalTurnControl(winner.value.value, input.bufferedDeliveries);
      if (terminal !== undefined) return terminal;
      if (
        winner.value.value.kind === "turn-delivery-cancelled" &&
        winner.value.value.requestId === input.request.requestId
      ) {
        return undefined;
      }
      continue;
    }

    if (winner.value.done) {
      throw new Error("Session delivery hook closed during a turn delivery request.");
    }

    input.consumeNext();
    if (winner.value.value.kind !== "deliver") continue;
    delivery = winner.value.value;
  }

  try {
    // Forwarding is provisional until the turn acknowledges it. A concurrent
    // cancellation or terminal result puts the delivery back for the parent.
    await forwardTurnDeliveryStep({
      inboxToken: input.request.inboxToken,
      payload: {
        delivery,
        kind: "driver-delivery",
        requestId: input.request.requestId,
      },
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === "HookNotFoundError")) throw error;
    input.bufferedDeliveries.unshift(delivery);
    return await waitForTerminalTurnControl({
      bufferedDeliveries: input.bufferedDeliveries,
      consumeCompletion: input.consumeCompletion,
      getCompletionPromise: input.getCompletionPromise,
      rekeyHook: input.rekeyHook,
      requestId: input.request.requestId,
    });
  }

  while (true) {
    const next = await input.getCompletionPromise();
    input.consumeCompletion();
    if (next.done) throw new Error("Turn completion hook closed before accepting a delivery.");

    if (next.value.kind === "turn-delivery-accepted") {
      if (next.value.requestId === input.request.requestId) return undefined;
      continue;
    }

    if (next.value.kind === "turn-continuation-token") {
      await input.rekeyHook(next.value.continuationToken);
      continue;
    }

    if (
      next.value.kind === "turn-delivery-cancelled" &&
      next.value.requestId === input.request.requestId
    ) {
      input.bufferedDeliveries.unshift(delivery);
      return undefined;
    }

    if (next.value.kind === "turn-result") {
      input.bufferedDeliveries.unshift(delivery);
    }
    const terminal = readTerminalTurnControl(next.value, input.bufferedDeliveries);
    if (terminal !== undefined) {
      return terminal;
    }
  }
}

async function waitForTerminalTurnControl(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly consumeCompletion: () => void;
  readonly getCompletionPromise: () => Promise<IteratorResult<TurnCompletionPayload>>;
  readonly rekeyHook: (nextToken: string) => Promise<void>;
  readonly requestId: string;
}): Promise<NextDriverAction | undefined> {
  while (true) {
    const next = await input.getCompletionPromise();
    input.consumeCompletion();
    if (next.done) throw new Error("Turn completion hook closed after delivery forwarding failed.");
    if (next.value.kind === "turn-continuation-token") {
      await input.rekeyHook(next.value.continuationToken);
      continue;
    }
    if (next.value.kind === "turn-delivery-cancelled" && next.value.requestId === input.requestId) {
      return undefined;
    }
    const terminal = readTerminalTurnControl(next.value, input.bufferedDeliveries);
    if (terminal !== undefined) return terminal;
  }
}

function readTerminalTurnControl(
  payload: TurnCompletionPayload,
  bufferedDeliveries: DeliverHookPayload[],
): NextDriverAction | undefined {
  if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
  if (payload.kind !== "turn-result") return undefined;
  if (payload.bufferedDeliveries !== undefined) {
    bufferedDeliveries.unshift(...payload.bufferedDeliveries);
  }
  return payload.action;
}
