// What a session relays about its own interactions to the session that serves it: every
// interaction fact, keyed by its own ids. The serving session mirrors each; this session decides
// all of them, and its settlements close the mirrors.

import type { RelayedInteractionEvent } from "#channel/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { askedCall } from "#protocol/session-projection/reader.js";
import { defined, fact } from "#harness/facts.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { interactionBatches } from "#protocol/session-projection/selectors.js";

/**
 * What this session relays for one of its own facts. A commit's requests relay together, as one
 * prompt: the first `interaction.opened` of a commit relays every request it opened, and the
 * rest relay nothing. An opened request names its origin: this session, its interaction, and
 * the call it asks about, which may be a call of a session this one serves in turn.
 */
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
    return fact("interaction.opened", {
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
    case "interaction.settled":
      return { data: event.data, type: "interaction.settled" };
    case "response.admitted": {
      const row = view.responses[event.data.responseId];
      if (row === undefined) return undefined;
      return {
        data: { deliveryId: row.deliveryId, interactionId: row.interactionId },
        type: "response.admitted",
      };
    }
    case "response.settled": {
      const { outcome, reason, responseId } = event.data;
      const row = view.responses[responseId];
      // A deciding answer settles with its interaction.
      if (row === undefined || outcome === "applied") return undefined;
      const { deliveryId, interactionId } = row;
      return {
        data: defined({ deliveryId, interactionId, outcome, reason }),
        type: "response.settled",
      };
    }
    default:
      return undefined;
  }
}
