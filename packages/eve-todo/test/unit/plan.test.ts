import assert from "node:assert/strict";
import test from "node:test";

import { latestTodos, planCard } from "../../extension/lib/plan.ts";
import type { TodoItem } from "../../extension/lib/todos.ts";

const items: TodoItem[] = [
  { content: "Read Alice's report", status: "completed" },
  { content: "Draft the summary", status: "in_progress" },
  { content: "Send it to Bob", status: "pending" },
  { content: "Book a meeting", status: "cancelled" },
];

test("the latest write call's list wins, and other tools are ignored", () => {
  const calls = [
    { input: { todos: [{ content: "Old", status: "pending" }] }, name: "todo__write" },
    { input: { todos: items }, name: "todo__write" },
    { input: { query: "x" }, name: "search" },
  ];
  assert.deepEqual(latestTodos(calls, "todo__write"), items);
  assert.equal(latestTodos(calls, "tasks__write"), undefined);
});

test("a withheld or invalid latest input shows no list, not an older one", () => {
  const calls = [{ input: { todos: items }, name: "todo__write" }, { name: "todo__write" }];
  assert.equal(latestTodos(calls, "todo__write"), undefined);
  assert.equal(
    latestTodos([{ input: { todos: "x" }, name: "todo__write" }], "todo__write"),
    undefined,
  );
  assert.equal(
    latestTodos([{ input: { todos: [] }, name: "todo__write" }], "todo__write"),
    undefined,
  );
});

test("the steps render as plan rows with Slack statuses", () => {
  const card = planCard(items, null, "eve_todo_turn_1");
  assert.deepEqual(card.blocks, [
    {
      block_id: "eve_todo_turn_1",
      tasks: [
        { status: "complete", task_id: "todo_0", title: "Read Alice's report" },
        { status: "in_progress", task_id: "todo_1", title: "Draft the summary" },
        { status: "pending", task_id: "todo_2", title: "Send it to Bob" },
        { status: "complete", task_id: "todo_3", title: "Book a meeting (skipped)" },
      ],
      title: "2 of 4 steps done",
      type: "plan",
    },
  ]);
  assert.equal(
    card.text,
    "2 of 4 steps done: Read Alice's report, Draft the summary, Send it to Bob, Book a meeting",
  );
});

test("eve's task rows follow the steps, from a plan or a single task card", () => {
  const row = { status: "in_progress", task_id: "task_a", title: "Researcher: Find incidents" };
  const fromPlan = planCard(
    items.slice(0, 1),
    {
      blocks: [{ block_id: "eve_task_card_x", tasks: [row, row], title: "Working", type: "plan" }],
      text: "Working",
    },
    "id",
  );
  assert.equal(rows(fromPlan).length, 3);
  const fromTaskCard = planCard(
    items.slice(0, 1),
    {
      blocks: [{ block_id: "eve_task_card_x", type: "task_card", ...row }],
      text: "Working",
    },
    "id",
  );
  assert.deepEqual(rows(fromTaskCard)[1], row);
  assert.equal(fromTaskCard.blocks[0]?.title, "Finished 1 step");
});

test("rows, titles, and text stay within Slack's limits", () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    content: `Step ${String(index)} ${"x".repeat(190)}`,
    status: "pending" as const,
  }));
  const row = { status: "in_progress", task_id: "task_a", title: "Task" };
  const card = planCard(many, { blocks: [{ type: "task_card", ...row }], text: "" }, "id");
  const tasks = rows(card) as { title: string }[];
  assert.equal(tasks.length, 50);
  assert.ok(tasks.every(({ title }) => title.length <= 100));
  assert.ok(card.text.length <= 3_000);
});

function rows(card: ReturnType<typeof planCard>): unknown[] {
  const tasks = card.blocks[0]?.tasks;
  assert.ok(Array.isArray(tasks));
  return tasks;
}
