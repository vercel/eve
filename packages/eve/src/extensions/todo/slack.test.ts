import { describe, expect, it } from "vitest";

import type { TaskCard } from "#channel/task-card.js";
import { emptySessionView } from "#protocol/session-projection/public-view.js";
import type { SlackCardMessage } from "#public/channels/slack/renderers.js";

import { todoSlackRenderer } from "./slack.ts";

const todos = [
  { content: "Read Alice's report", status: "completed" },
  { content: "Send the summary to Bob", status: "in_progress" },
];

function card(calls: readonly { name: string; input?: { todos: typeof todos } }[]): TaskCard {
  return {
    audience: "private",
    calls: calls.map((call, index) => ({
      ...call,
      callId: `call_${String(index)}`,
      kind: "tool",
      label: "Write",
      state: "completed",
    })),
    since: 0,
    state: "working",
    turnId: "turn_1",
    view: emptySessionView(),
  };
}

const eveCard: SlackCardMessage = {
  blocks: [
    {
      block_id: "eve_task_card_1",
      status: "in_progress",
      task_id: "t",
      title: "Research",
      type: "task_card",
    },
  ],
  text: "Research",
};

describe("todoSlackRenderer", () => {
  it("puts the latest checklist ahead of eve's task rows", () => {
    const rendered = todoSlackRenderer().taskCard?.(
      card([{ input: { todos }, name: "todo__write" }]),
      () => eveCard,
    );
    expect(rendered?.blocks).toEqual([
      {
        block_id: "eve_todo_turn_1",
        tasks: [
          { status: "complete", task_id: "todo_0", title: "Read Alice's report" },
          { status: "in_progress", task_id: "todo_1", title: "Send the summary to Bob" },
          { status: "in_progress", task_id: "t", title: "Research" },
        ],
        title: "1 of 2 steps done",
        type: "plan",
      },
    ]);
  });

  it("keeps eve's card when the turn didn't write the list under this mount", () => {
    const calls = card([{ input: { todos }, name: "todo__write" }]);
    expect(todoSlackRenderer({ mount: "checklist" }).taskCard?.(calls, () => eveCard)).toBe(
      eveCard,
    );
    expect(todoSlackRenderer().taskCard?.(card([]), () => null)).toBeNull();
  });
});
