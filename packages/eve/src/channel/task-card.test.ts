import { describe, expect, it } from "vitest";

import { createActionResultEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

import { taskCardView, trackTaskCardEvent, type TaskCardTurn } from "./task-card.js";

const AT = "2026-09-30T00:00:00.000Z";

function fold(events: readonly UnstampedMessageStreamEvent[]): TaskCardTurn {
  let turns: Readonly<Record<string, TaskCardTurn>> = {};
  for (const event of events) turns = { ...turns, ...trackTaskCardEvent(turns, event, AT) };
  return turns["turn-1"]!;
}

describe("task card", () => {
  it("shows a connection call as one row, not also its nested connection tool", () => {
    const turn = fold([
      {
        type: "actions.requested",
        data: {
          turnId: "turn-1",
          sequence: 0,
          stepIndex: 0,
          actions: [
            {
              kind: "tool-call",
              callId: "call-1",
              toolName: "connection_execute",
              input: { connection: "kennel", tool: "book_visit", input: {} },
            },
          ],
          presentation: { "call-1": { label: "kennel__book_visit" } },
        },
      },
      {
        type: "actions.requested",
        data: {
          turnId: "turn-1",
          sequence: 1,
          stepIndex: 0,
          actions: [
            {
              kind: "tool-call",
              callId: "call-1:nested",
              parentCallId: "call-1",
              toolName: "kennel__book_visit",
              input: {},
            },
          ],
        },
      },
      ...["call-1:nested", "call-1"].map((callId, index) =>
        createActionResultEvent({
          result: { kind: "tool-result", callId, toolName: "connection_execute", output: {} },
          sequence: 2 + index,
          stepIndex: 0,
          turnId: "turn-1",
        }),
      ),
    ]);

    const { actions } = taskCardView("turn-1", turn, { audience: "public" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: "call-1", status: "completed" });
    expect(JSON.stringify(actions[0])).toContain("kennel__book_visit");
  });
});
