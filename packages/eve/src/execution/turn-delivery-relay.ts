import type { DeliverHookPayload } from "#channel/types.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";

type DeliveryRequest = Extract<TurnCompletionPayload, { readonly kind: "turn-delivery-request" }>;

/** Relays one public session delivery requested by an active turn. */
export async function serviceTurnDeliveryRequest(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly consumeCompletion: () => void;
  readonly deliveryHook: SessionDeliveryHook;
  readonly getCompletionPromise: () => Promise<IteratorResult<TurnCompletionPayload>>;
  readonly request: DeliveryRequest;
}): Promise<NextDriverAction | undefined> {
  await input.deliveryHook.rekey(input.request.continuationToken);

  let delivery = input.bufferedDeliveries.shift();
  while (delivery === undefined) {
    const winner = await Promise.race([
      input.getCompletionPromise().then((value) => ({ kind: "control" as const, value })),
      input.deliveryHook.next().then((value) => ({ kind: "delivery" as const, value })),
    ]);

    if (winner.kind === "control") {
      input.consumeCompletion();
      if (winner.value.done) {
        throw new Error("Turn completion hook closed during a delivery request.");
      }
      if (winner.value.value.kind === "turn-continuation-token") {
        await input.deliveryHook.rekey(winner.value.value.continuationToken);
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

    input.deliveryHook.consumeNext();
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
      rekeyHook: input.deliveryHook.rekey,
      requestId: input.request.requestId,
    });
  }

  while (true) {
    const payload = await nextTurnControl({
      consumeCompletion: input.consumeCompletion,
      getCompletionPromise: input.getCompletionPromise,
      onClosed: "Turn completion hook closed before accepting a delivery.",
      rekeyHook: input.deliveryHook.rekey,
    });

    if (payload.kind === "turn-delivery-accepted") {
      if (payload.requestId === input.request.requestId) return undefined;
      continue;
    }

    if (
      payload.kind === "turn-delivery-cancelled" &&
      payload.requestId === input.request.requestId
    ) {
      input.bufferedDeliveries.unshift(delivery);
      return undefined;
    }

    if (payload.kind === "turn-result") {
      input.bufferedDeliveries.unshift(delivery);
    }
    const terminal = readTerminalTurnControl(payload, input.bufferedDeliveries);
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
    const payload = await nextTurnControl({
      consumeCompletion: input.consumeCompletion,
      getCompletionPromise: input.getCompletionPromise,
      onClosed: "Turn completion hook closed after delivery forwarding failed.",
      rekeyHook: input.rekeyHook,
    });
    if (payload.kind === "turn-delivery-cancelled" && payload.requestId === input.requestId) {
      return undefined;
    }
    const terminal = readTerminalTurnControl(payload, input.bufferedDeliveries);
    if (terminal !== undefined) return terminal;
  }
}

/**
 * Reads the next turn control payload, transparently rekeying the public hook
 * on `turn-continuation-token` and rethrowing `turn-error`, so callers only
 * switch on the delivery-handshake and terminal arms.
 */
export async function nextTurnControl(input: {
  readonly consumeCompletion: () => void;
  readonly getCompletionPromise: () => Promise<IteratorResult<TurnCompletionPayload>>;
  readonly onClosed: string;
  readonly rekeyHook: (nextToken: string) => Promise<void>;
}): Promise<
  Exclude<TurnCompletionPayload, { readonly kind: "turn-error" | "turn-continuation-token" }>
> {
  while (true) {
    const next = await input.getCompletionPromise();
    input.consumeCompletion();
    if (next.done) throw new Error(input.onClosed);
    const payload = next.value;
    if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);
    if (payload.kind === "turn-continuation-token") {
      await input.rekeyHook(payload.continuationToken);
      continue;
    }
    return payload;
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
