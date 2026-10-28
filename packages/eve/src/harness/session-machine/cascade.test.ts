import { describe, expect, it } from "vitest";

import { cascade } from "#harness/session-machine/cascade.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

const turnId = "turn_0";
const runId = "run_0";

function viewOf(...lines: SessionEvent[][]): SessionView {
  const view = emptySessionView();
  for (const facts of lines)
    foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, view.position);
  return view;
}

const open: SessionEvent[] = [
  { data: {}, type: "session.started" },
  { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
  { data: { cause: { deliveryId: "d_1" }, follows: null, turnId }, type: "turn.started" },
  { data: { deliveryId: "d_1", parts: [], turnId }, type: "delivery.consumed" },
  { data: { owner: { turnId }, runId }, type: "model.requested" },
  {
    data: { callId: "c_1", capability: { kind: "tool", name: "deploy" }, owner: { runId } },
    type: "call.requested",
  },
  {
    data: {
      interactionId: "i_1",
      request: { kind: "approval", prompt: "Deploy?" },
      subject: { callId: "c_1" },
    },
    type: "interaction.opened",
  },
];

const outcomes = (events: readonly SessionEvent[]) =>
  events.map((event) => `${event.type}:${(event.data as { outcome?: string }).outcome ?? ""}`);

describe("cascade", () => {
  it("leaves the calls a completed run made open, under its turn", () => {
    const events = cascade(viewOf(open), [
      { data: { outcome: "completed", runId }, type: "model.settled" },
    ]);
    expect(outcomes(events)).toEqual(["model.settled:completed"]);
  });

  it("abandons what a retried run announced, leaves first", () => {
    const events = cascade(viewOf(open), [
      { data: { outcome: "abandoned", runId }, type: "model.settled" },
    ]);
    expect(outcomes(events)).toEqual([
      "interaction.settled:abandoned",
      "call.settled:abandoned",
      "model.settled:abandoned",
    ]);
    expect(events[1]).toMatchObject({ data: { reason: "model-call-retried" } });
  });

  it("closes a turn's work before it and settles its deliveries after it", () => {
    const events = cascade(viewOf(open), [
      { data: { outcome: "cancelled", turnId }, type: "turn.settled" },
    ]);
    expect(outcomes(events)).toEqual([
      "interaction.settled:interrupted",
      "call.settled:interrupted",
      "model.settled:interrupted",
      "turn.settled:cancelled",
      "delivery.settled:handled",
    ]);
  });

  it("closes a question about a call when the call ends", () => {
    const events = cascade(viewOf(open), [
      { data: { callId: "c_1", outcome: "failed" }, type: "call.settled" },
    ]);
    expect(outcomes(events)).toEqual(["interaction.settled:interrupted", "call.settled:failed"]);
  });

  it("leaves what the commit closes itself to it", () => {
    const events = cascade(viewOf(open), [
      { data: { outcome: "cancelled", turnId }, type: "turn.settled" },
      { data: { deliveryId: "d_1", outcome: "applied" }, type: "delivery.settled" },
    ]);
    expect(outcomes(events).filter((entry) => entry.startsWith("delivery"))).toEqual([
      "delivery.settled:applied",
    ]);
  });

  it("withdraws an interaction's open answers with its reason", () => {
    const answered: SessionEvent = {
      data: { deliveryId: "d_1", interactionId: "i_1", responseId: "r_1", value: {} },
      type: "response.submitted",
    };
    const events = cascade(viewOf(open, [answered]), [
      {
        data: { interactionId: "i_1", outcome: "withdrawn", reason: "asker-ended" },
        type: "interaction.settled",
      },
    ]);
    expect(outcomes(events)).toEqual([
      "response.settled:withdrawn",
      "interaction.settled:withdrawn",
    ]);
    expect(events[0]).toMatchObject({ data: { reason: "asker-ended", responseId: "r_1" } });
  });

  it("ends a turn its session's end closes with the reply it collected", () => {
    const reply: SessionEvent = {
      data: { kind: "text", partId: "p_1", phase: "reply", runId, value: "Done." },
      type: "content.completed",
    };
    const events = cascade(viewOf(open, [reply]), [
      { data: { outcome: "failed" }, type: "session.ended" },
    ]);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "cancelled", reply: ["p_1"], turnId },
    });
    expect(events.at(-1)?.type).toBe("session.ended");
  });

  it("stamps each fact with the owners the tree gives it", () => {
    const [requested] = cascade(viewOf(open.slice(0, 5)), [open[5]!]);
    expect(requested?.scope).toEqual({ runId, turnId });
  });
});
