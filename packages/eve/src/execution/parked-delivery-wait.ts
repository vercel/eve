import type { DeliverHookPayload, DeliverPayload, SessionControlCommand } from "#channel/types.js";
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

export type BufferedSessionControl = SessionControlCommand | { readonly kind: "expired" };

type NextSessionAction =
  | BufferedSessionControl
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
  | BufferedSessionControl
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
  readonly bufferedSessionControls: BufferedSessionControl[];
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
  readonly bufferedSessionControls: BufferedSessionControl[];
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

    if (nextAction.kind !== "delivery") return nextAction;

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
  readonly bufferedSessionControls: BufferedSessionControl[];
  readonly cancelledTaskIds: Set<string>;
  readonly commandInbox: SessionCommandInbox;
  readonly deferDeliveries?: boolean;
  readonly seenTaskDeliveries: Set<string>;
  readonly stateCursor: SessionStateCursor;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) return pendingSessionControl;

  while (
    input.bufferedDeliveries[0] !== undefined &&
    isCancelledTaskDelivery(input.bufferedDeliveries[0], input.cancelledTaskIds)
  ) {
    input.bufferedDeliveries.shift();
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

    if (
      decoded.kind === "clear" ||
      decoded.kind === "compact" ||
      decoded.kind === "reset" ||
      decoded.kind === "restore-history"
    ) {
      return decoded;
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

    if (input.deferDeliveries === true) {
      input.bufferedDeliveries.push(decoded);
      continue;
    }
    return { delivery: decoded, kind: "delivery" };
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
