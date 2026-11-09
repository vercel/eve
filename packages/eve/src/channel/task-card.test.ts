import { describe, expect, it } from "vitest";

import { taskCards, workingTaskNames } from "#channel/task-card.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { JsonValue } from "#shared/json.js";

const turnId = "turn_0";
const scope = { runId: "run_0", turnId };

/** Folds each commit as the server does, with operational retention, so cards read what it keeps. */
function serverView(commits: readonly (readonly SessionEvent[])[]): SessionView {
  const view = emptySessionView();
  commits.forEach((facts, position) =>
    foldLine(view, { at: `2026-10-13T00:00:0${position}.000Z`, facts }, position, {
      retention: "operational",
    }),
  );
  return view;
}

const opening: SessionEvent[][] = [
  [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
  ],
  [
    { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
    { data: { deliveryId: "d_0", parts: [], turnId }, type: "delivery.consumed" },
    { data: { owner: { turnId }, runId: "run_0" }, scope, type: "model.requested" },
  ],
];

function requested(callId: string, name: string, kind: "agent" | "tool" = "tool"): SessionEvent {
  return {
    data: { callId, capability: { kind, name }, input: { q: callId }, owner: { runId: "run_0" } },
    scope,
    type: "call.requested",
  };
}

function startsTask(callId: string, taskId: string, name: string): SessionEvent[] {
  return [
    { data: { kind: "agent", name, startedBy: { callId }, taskId }, type: "task.started" },
    { data: { callId, taskId }, scope, type: "call.started" },
  ];
}

const settled = (callId: string, output: JsonValue): SessionEvent => ({
  data: { callId, outcome: "completed", output },
  scope,
  type: "call.settled",
});

describe("task cards read from the server's tables", () => {
  it("holds a turn's own calls, blocked while a task asks someone, until its tasks end", () => {
    const working = serverView([
      ...opening,
      [requested("plan", "plan"), requested("research", "researcher", "agent")],
      [...startsTask("research", "t_1", "researcher"), settled("plan", { steps: [] })],
      [
        { data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" },
        {
          data: {
            interactionId: "ask_1",
            request: { kind: "question", prompt: "Which region?" },
            subject: { taskId: "t_1" },
          },
          type: "interaction.opened",
        },
      ],
    ]);
    const [card] = taskCards(working, turnId, "private");
    expect(card?.state).toBe("blocked");
    expect(card?.calls.map((row) => [row.callId, row.taskId])).toEqual([
      ["plan", undefined],
      ["research", "t_1"],
    ]);
    expect(card?.audience).toBe("private");
    expect(workingTaskNames(working, turnId)).toEqual(["researcher"]);

    // The turn settles while its task works; the card keeps its rows until the task ends.
    const finished = serverView([
      ...opening,
      [requested("plan", "plan"), requested("research", "researcher", "agent")],
      [...startsTask("research", "t_1", "researcher"), settled("plan", { steps: [] })],
      [{ data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" }],
      [{ data: { outcome: "completed", turnId }, type: "turn.settled" }],
      [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }],
      [settled("research", { message: "Use us-east. It is closest." })],
      [{ data: { outcome: "completed", taskId: "t_1" }, type: "task.ended" }],
    ]);
    const [done] = taskCards(finished, turnId, "private");
    expect(done?.state).toBe("finished");
    expect(done?.calls.map((row) => row.callId)).toEqual(["plan", "research"]);
  });

  it("starts a new card for a task begun after the card's tasks ended, with calls still working", () => {
    const view = serverView([
      ...opening,
      [requested("first", "researcher", "agent"), requested("watch", "watch")],
      [...startsTask("first", "t_1", "researcher")],
      [settled("first", "Found it.")],
      [requested("second", "researcher", "agent")],
      [...startsTask("second", "t_2", "researcher")],
    ]);
    const cards = taskCards(view, turnId, "private");
    expect(cards.map((card) => [card.since, card.state])).toEqual([
      [0, "finished"],
      [5, "working"],
    ]);
    expect(cards[0]?.calls.map((row) => row.callId)).toEqual(["first"]);
    // `watch` was still working when the next card began, so it moved there.
    expect(cards[1]?.calls.map((row) => row.callId)).toEqual(["watch", "second"]);
  });

  it("keeps one card while an earlier task still works, and for one that ends in the same line", () => {
    const view = serverView([
      ...opening,
      [requested("first", "researcher", "agent")],
      [...startsTask("first", "t_1", "researcher")],
      [settled("first", "Found it."), requested("second", "researcher", "agent")],
      [...startsTask("second", "t_2", "researcher"), requested("third", "researcher", "agent")],
      [...startsTask("third", "t_3", "researcher")],
    ]);
    expect(taskCards(view, turnId, "private").map((card) => card.calls.length)).toEqual([3]);
  });
});
