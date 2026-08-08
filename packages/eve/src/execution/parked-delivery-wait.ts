import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import type { ChannelIdempotencyGuard } from "#execution/channel-idempotency.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
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
export type NextTurnInstruction =
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
  readonly commandInbox: SessionCommandInbox;
  readonly idempotency: ChannelIdempotencyGuard;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
}): Promise<NextTurnInstruction> {
  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      bufferedSessionControls: input.bufferedSessionControls,
      commandInbox: input.commandInbox,
      idempotency: input.idempotency,
    });

    if (nextAction.kind !== "delivery") {
      return { kind: nextAction.kind };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed" };
    }

    const routed = await routeDeliverToChildren({
      auth: deliver.auth,
      parentWritable: input.driverWritable,
      payloads: deliver.payloads,
      sessionState: input.sessionState,
    });

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn" };
    }

    if (routed.remainder === undefined) {
      // Fully routed to a descendant; keep waiting.
      continue;
    }

    return { deliver, kind: "turn", remainder: routed.remainder };
  }
}

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
  readonly idempotency: ChannelIdempotencyGuard;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
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
      continue;
    }

    if (first.value.kind === "deliver") {
      if (!input.idempotency.accept(first.value.idempotencyKey)) continue;
      return { delivery: first.value, kind: "delivery" };
    }

    const delivery = sendCommandToDelivery(first.value);
    if (!input.idempotency.accept(delivery.idempotencyKey)) continue;
    return { delivery, kind: "delivery" };
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
