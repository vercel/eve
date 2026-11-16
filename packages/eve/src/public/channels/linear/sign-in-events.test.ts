import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import { createDefaultEvents } from "#public/channels/linear/defaults.js";

const activities = vi.hoisted(() => [] as unknown[]);
vi.mock("#public/channels/linear/api.js", () => ({
  createLinearAgentActivity: vi.fn(async (input: { activity: unknown }) => {
    activities.push(input.activity);
    return { id: `activity_${activities.length}`, success: true };
  }),
}));

const turnId = "turn_0";

/** Two Weather sign-ins on one turn: `s_waiting` waits on `s_shown`'s card. */
function twoSignIns() {
  const view = emptySessionView();
  const opened = (interactionId: string, waitsOn?: string): SessionEvent =>
    ({
      data: {
        interactionId,
        request: {
          kind: "sign-in",
          prompt: "Sign in to Weather.",
          signIn: {
            displayName: "Weather",
            name: "weather",
            url: "https://idp.example/authorize",
            ...(waitsOn !== undefined && { waitsOn }),
          },
        },
        subject: { turnId },
      },
      type: "interaction.opened",
    }) as SessionEvent;
  const facts: SessionEvent[] = [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
    opened("s_shown"),
    opened("s_waiting", "s_shown"),
  ];
  foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, 0);
  return { facts, view };
}

describe("Linear sign-ins that wait on a card already shown", () => {
  it("posts no card when one opens and nothing when it ends", async () => {
    const events = createDefaultEvents();
    const { facts, view } = twoSignIns();
    const ctx = {
      channel: { state: { agentSessionId: "as_1" } },
      session: { auth: {} },
      view: snapshotOf(view),
    };
    const run = (fact: SessionEvent) =>
      (events[fact.type as keyof typeof events] as (e: SessionEvent, c: unknown) => Promise<void>)(
        fact,
        ctx,
      );

    await run(facts[3]!);
    await run(facts[4]!);
    expect(activities, "the one card Linear shows").toHaveLength(1);

    for (const data of [
      { interactionId: "s_waiting", outcome: "accepted" },
      { interactionId: "s_waiting", outcome: "failed", reason: "access_denied" },
    ])
      await run({ data, type: "interaction.settled" } as SessionEvent);
    expect(activities, "nothing for the waiting sign-in's ending").toHaveLength(1);

    await run({
      data: { interactionId: "s_shown", outcome: "accepted" },
      type: "interaction.settled",
    } as SessionEvent);
    expect(activities, "the shown card's ending").toHaveLength(2);
  });
});
