import { usageOf } from "#harness/facts.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import { withModelUsage } from "#harness/session-usage.js";
import { advance } from "#harness/session-machine/current.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionStateMap } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The session with `usage` as what its view records it spent, as model usage. */
export function withSessionUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: Partial<TokenUsage>,
): T {
  const projection = storedProjection(session.state);
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_PROJECTION_STATE_KEY]: {
        ...projection,
        view: withModelUsage(projection.view, usageOf(usage)),
      },
    },
  };
}

/** Renew through the recorded acceptance, not a private window setter. */
export function acceptSessionBudget<T extends { readonly state?: SessionStateMap }>(session: T): T {
  const projection = storedProjection(session.state);
  const interactionId = `budget_${projection.view.position}`;
  const facts: SessionEvent[] = [
    ...(projection.view.session.status === "new"
      ? [{ type: "session.started" as const, data: {} }]
      : []),
    {
      type: "interaction.opened",
      data: {
        interactionId,
        subject: { turnId: "turn_0" },
        request: { kind: "budget", prompt: "Continue?" },
      },
    },
    { type: "interaction.settled", data: { interactionId, outcome: "accepted" } },
  ];
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_PROJECTION_STATE_KEY]: advance(
        projection,
        { at: "2026-10-22T00:00:00.000Z", facts },
        projection.view.position,
        facts,
      ),
    },
  };
}
