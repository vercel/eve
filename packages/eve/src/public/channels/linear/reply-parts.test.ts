import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { createDefaultEvents } from "#public/channels/linear/defaults.js";
import type { LinearChannelState } from "#public/channels/linear/linearChannel.js";

const activities = vi.hoisted(() => [] as unknown[]);
vi.mock("#public/channels/linear/api.js", () => ({
  createLinearAgentActivity: vi.fn(async (input: { activity: unknown }) => {
    activities.push(input.activity);
    return { id: `activity_${activities.length}`, success: true };
  }),
}));

const card: SessionEvent = {
  data: {
    callId: "call_0",
    fallbackText: "Deploys: 1,284",
    kind: "card",
    partId: "call_0.reply",
    phase: "reply",
    value: {},
  },
  type: "content.completed",
};
const text: SessionEvent = {
  data: { kind: "text", partId: "p_0", phase: "reply", runId: "run_0", value: "Deploys were up." },
  type: "content.completed",
};
const settled: SessionEvent = {
  data: { outcome: "completed", turnId: "turn_0" },
  type: "turn.settled",
};

function linearTurn() {
  const events = createDefaultEvents();
  const state: LinearChannelState = { agentSessionId: "as_1" };
  const ctx = { channel: { state }, session: { auth: {} } };
  return (event: SessionEvent) =>
    (events[event.type as keyof typeof events] as (e: SessionEvent, c: unknown) => Promise<void>)(
      event,
      ctx,
    );
}

describe("Linear reply parts it can't show", () => {
  beforeEach(() => {
    activities.length = 0;
  });

  // Linear marks a session complete on a `response`, so a card never posts one mid-turn.
  it("shows a card's fallback text with the turn's text response", async () => {
    const run = linearTurn();
    await run(card);
    expect(activities).toEqual([]);
    await run(text);
    await run(settled);

    expect(activities).toEqual([
      expect.objectContaining({
        content: { body: "Deploys: 1,284\n\nDeploys were up.", type: "response" },
      }),
    ]);
  });

  it("posts a card that was the turn's whole answer when the turn settles", async () => {
    const run = linearTurn();
    await run(card);
    await run(settled);

    expect(activities).toEqual([
      expect.objectContaining({ content: { body: "Deploys: 1,284", type: "response" } }),
    ]);
  });
});
