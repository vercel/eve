import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionBacklog, SessionControl } from "#execution/session-backlog.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { routeSessionPayload } from "#execution/session-routing.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

/** What the parked owner should do with the next session activity. */
export type NextTurnInstruction =
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: "authorization"; readonly payloads: readonly DeliverPayload[] }
  | { readonly kind: SessionControl }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "turn"; readonly delivery: DeliverHookPayload };

/**
 * Awaits the next activity that requires owner action while the session is
 * parked. Deliveries fully routed to a descendant leave the parent with no
 * turn to run, so this keeps waiting until a delivery produces a parent turn,
 * a control, a cancellation, or hook closure. The wait is unbounded by design.
 *
 * With `awaitAuthorizationCallbacks`, the inbox's authorization window stays
 * open for the whole wait — including iterations that consume activity
 * without producing a parent turn — so an open challenge's callback surfaces
 * as an `"authorization"` instruction no matter when it arrives.
 */
export async function nextTurnDelivery(input: {
  readonly awaitAuthorizationCallbacks?: boolean;
  readonly backlog: SessionBacklog;
  readonly commandInbox: SessionInbox;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
}): Promise<NextTurnInstruction> {
  if (input.awaitAuthorizationCallbacks !== true) return await awaitNextTurnDelivery(input);

  input.commandInbox.setAuthorizationWindow(true);
  try {
    return await awaitNextTurnDelivery(input);
  } finally {
    input.commandInbox.setAuthorizationWindow(false);
  }
}

async function awaitNextTurnDelivery(input: {
  readonly backlog: SessionBacklog;
  readonly commandInbox: SessionInbox;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
}): Promise<NextTurnInstruction> {
  const { backlog, commandInbox, cursor } = input;
  const control = backlog.takeControl();
  if (control !== undefined) return { kind: control };

  while (true) {
    if (input.deferDeliveries !== true && !commandInbox.hasReadyAuthorization()) {
      const delivery = backlog.takeTurn(
        getSessionTaskCohorts(cursor.sessionState.snapshot.session.state),
      );
      if (delivery !== undefined) {
        const routed = await routeDeliverToChildren({
          delivery,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        cursor.adoptState(routed);
        if (routed.kind === "cancel-turn") return { kind: "cancel-turn" };
        if (routed.remainder === undefined) continue;
        return { delivery: routed.remainder, kind: "turn" };
      }
    }

    const read = await commandInbox.next("runtime");
    if (read.done) return { kind: "closed" };
    commandInbox.consumeNext("runtime");

    // Parked deliveries are routed to children only once they are selected as
    // a turn above, so cohort batching sees the whole notification.
    const routed = await routeSessionPayload(read.value, {
      backlog,
      cursor,
      routeDeliveries: false,
    });
    switch (routed.kind) {
      case "workflow":
        return { kind: "workflow", message: routed.message };
      case "authorization":
        return { kind: "authorization", payloads: routed.payload.payloads };
      case "cancel":
      case "buffered":
      case "consumed":
      case "runtime-action-result":
        // A parked session has no active turn to cancel; a late runtime result
        // arriving through an old alias has always been ignored here.
        break;
    }
    const buffered = backlog.takeControl();
    if (buffered !== undefined) return { kind: buffered };
  }
}
