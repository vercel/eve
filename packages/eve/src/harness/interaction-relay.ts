import type { RelayedInteractionEvent } from "#channel/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { askedCall } from "#protocol/session-projection/reader.js";
import { relayEvent } from "#channel/relay-event.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { interactionBatches } from "#protocol/session-projection/selectors.js";

export function relayedInteractionEvents(
  view: SessionView,
  event: SessionEvent,
  sessionId: string,
): readonly RelayedInteractionEvent[] {
  if (event.type !== "interaction.opened") {
    const relayed = relayedFact(view, event);
    return relayed === undefined ? [] : [relayed];
  }
  const row = view.interactions[event.data.interactionId];
  const batch = interactionBatches(view, { signIns: true }).find((entries) => entries[0] === row);
  return (batch ?? []).map((entry) => {
    const call = askedCall(view, entry);
    const origin = { interactionId: entry.interactionId, sessionId };
    return relayEvent("interaction.opened", {
      audience: entry.audience,
      interactionId: entry.interactionId,
      origin: call === undefined ? origin : { ...origin, call },
      request: entry.request,
      subject: entry.subject,
    });
  });
}

function relayedFact(view: SessionView, event: SessionEvent): RelayedInteractionEvent | undefined {
  switch (event.type) {
    case "interaction.settled": {
      const { cause } = event.data;
      const decider =
        cause !== undefined && "responseId" in cause ? view.responses[cause.responseId] : undefined;
      return relayEvent(
        "interaction.settled",
        decider === undefined
          ? event.data
          : { ...event.data, cause: { deliveryId: decider.deliveryId } },
      );
    }
    case "response.admitted": {
      const row = view.responses[event.data.responseId];
      if (row === undefined) return undefined;
      return relayEvent("response.admitted", {
        deliveryId: row.deliveryId,
        interactionId: row.interactionId,
      });
    }
    case "response.settled": {
      const { outcome, reason, responseId } = event.data;
      const row = view.responses[responseId];
      if (row === undefined || outcome === "applied") return undefined;
      const { deliveryId, interactionId } = row;
      return relayEvent("response.settled", { deliveryId, interactionId, outcome, reason });
    }
    default:
      return undefined;
  }
}
