import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import { coalesceDeliveries } from "#harness/messages.js";

type NextSessionAction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | Omit<AuthorizationCallbackInstruction, "sessionState">
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
  readonly sessionState: DurableSessionState;
}

/** What the parked driver should do with the next session activity. */
export type NextTurnInstruction =
  | { readonly kind: "clear"; readonly sessionState: DurableSessionState }
  | { readonly kind: "compact"; readonly sessionState: DurableSessionState }
  | { readonly kind: "expired"; readonly sessionState: DurableSessionState }
  | { readonly kind: "reset"; readonly sessionState: DurableSessionState }
  | { readonly kind: "closed"; readonly sessionState: DurableSessionState }
  | { readonly kind: "cancel-turn"; readonly sessionState: DurableSessionState }
  | AuthorizationCallbackInstruction
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
 *
 * With `awaitAuthorizationCallbacks`, the inbox's authorization window stays
 * open for the whole wait — including iterations that consume activity
 * without producing a parent turn (no-op cancels, fully-routed descendant
 * deliveries) — so an open challenge's callback surfaces as an
 * `"authorization"` instruction no matter when it arrives.
 */
export async function nextTurnDelivery(input: {
  readonly awaitAuthorizationCallbacks?: boolean;
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
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
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
}): Promise<NextTurnInstruction> {
  let sessionState = input.sessionState;

  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      bufferedSessionControls: input.bufferedSessionControls,
      commandInbox: input.commandInbox,
      deferDeliveries: input.deferDeliveries,
    });

    if (nextAction.kind === "authorization") {
      return { ...nextAction, sessionState };
    }

    if (nextAction.kind !== "delivery") {
      return { kind: nextAction.kind, sessionState };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed", sessionState };
    }

    const routed = await routeDeliverToChildren({
      auth: deliver.auth,
      parentWritable: input.driverWritable,
      payloads: deliver.payloads,
      sessionState,
    });
    sessionState = routed.sessionState;

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn", sessionState };
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
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
  }

  if (
    input.deferDeliveries !== true &&
    !input.commandInbox.hasReadyAuthorization() &&
    input.bufferedDeliveries.length > 0
  ) {
    return {
      delivery: takeBufferedTurnDelivery(input.bufferedDeliveries),
      kind: "delivery",
    };
  }

  while (true) {
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
      if (input.deferDeliveries === true) {
        input.bufferedDeliveries.push(first.value);
        continue;
      }
      return { delivery: first.value, kind: "delivery" };
    }

    const delivery = sendCommandToDelivery(first.value);
    if (input.deferDeliveries === true) {
      input.bufferedDeliveries.push(delivery);
      continue;
    }
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
