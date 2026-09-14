import type { DeliverPayload } from "#channel/types.js";
import { routeSelectedDelivery } from "#execution/selected-delivery-router.js";
import type { SessionInputLedger } from "#execution/session-input-ledger.js";
import type {
  SessionControl,
  SessionInputQueue,
  TurnSelection,
} from "#execution/session-input-queue.js";
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload, applySessionCancellation } from "#execution/session-routing.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

export type NextTurnInstruction =
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: "authorization"; readonly payloads: readonly DeliverPayload[] }
  | { readonly kind: SessionControl }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | TurnSelection;

export async function nextTurnDelivery(input: {
  readonly awaitAuthorizationCallbacks?: boolean;
  readonly commandInbox: SessionInboxReader;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
  readonly ledger: SessionInputLedger;
  readonly queue: SessionInputQueue;
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
  readonly commandInbox: SessionInboxReader;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
  readonly ledger: SessionInputLedger;
  readonly queue: SessionInputQueue;
}): Promise<NextTurnInstruction> {
  const { commandInbox, cursor, queue } = input;
  while (true) {
    if (!commandInbox.hasReadyAuthorization()) {
      const selected = queue.takeNext(
        getSessionTaskCohorts(cursor.sessionState.snapshot.session.state),
        {
          deferDeliveries: input.deferDeliveries,
          isTaskCancelled: (taskId) => input.ledger.isTaskCancelled(taskId),
        },
      );
      if (selected?.kind === "control") return { kind: selected.control };
      if (selected?.kind === "turn") {
        const routed = await routeSelectedDelivery(selected, cursor);
        if (routed.kind === "cancel-turn") return routed;
        if (routed.kind === "consumed") continue;
        return routed;
      }
    }

    const lease = await commandInbox.read("runtime");
    if (lease === undefined) return { kind: "closed" };
    lease.consume();

    const admitted = await admitSessionInboxPayload(lease.value, input);
    switch (admitted.kind) {
      case "workflow":
        return { kind: "workflow", message: admitted.message };
      case "authorization":
        return { kind: "authorization", payloads: admitted.payload.payloads };
      case "cancel":
        await applySessionCancellation(admitted.command, input);
        break;
      case "delivery":
      case "consumed":
      case "runtime-action-result":
        break;
    }
  }
}
