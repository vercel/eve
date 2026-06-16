import { describe, expect, it } from "vitest";

import type { ModelMessage } from "ai";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  executeTodoTool,
  getTodoCompactionMessage,
  type TodoItem,
  type TodoState,
  TodoStateKey,
} from "#runtime/framework-tools/todo.js";

function runInContext(
  fn: () => unknown,
  state?: TodoState,
): { context: ContextContainer; result: unknown } {
  const ctx = new ContextContainer();
  ctx.set(TodoStateKey, state ?? { items: [] });
  const result = contextStorage.run(ctx, fn);
  return { context: ctx, result };
}

const sampleTodos: TodoItem[] = [
  { content: "Fix the bug", priority: "high", status: "in_progress" },
  { content: "Write tests", priority: "medium", status: "pending" },
  { content: "Update docs", priority: "low", status: "completed" },
];

describe("executeTodoTool", () => {
  describe("read (no todos param)", () => {
    it("returns empty list when no state exists", () => {
      const { result } = runInContext(() => executeTodoTool({}));

      expect(result).toEqual({
        counts: { cancelled: 0, completed: 0, in_progress: 0, pending: 0, total: 0 },
        todos: [],
      });
    });

    it("returns current list when state has items", () => {
      const { result } = runInContext(() => executeTodoTool({}), { items: sampleTodos });

      const output = result as { counts: Record<string, number>; todos: readonly TodoItem[] };
      expect(output.todos).toHaveLength(3);
      expect(output.counts).toEqual({
        cancelled: 0,
        completed: 1,
        in_progress: 1,
        pending: 1,
        total: 3,
      });
    });

    it("handles empty input gracefully", () => {
      // The runtime execute wrapper coerces nullish model input into
      // `{}` before calling executeTodoTool, so the typed executor only
      // ever sees a valid TodoToolInput. This test verifies the
      // empty-object case returns the current (empty) list.
      const { result } = runInContext(() => executeTodoTool({}));

      const output = result as { todos: readonly TodoItem[] };
      expect(output.todos).toEqual([]);
    });
  });

  describe("write (todos param provided)", () => {
    it("replaces the entire list", () => {
      const { context, result } = runInContext(() => executeTodoTool({ todos: sampleTodos }));

      const output = result as { counts: Record<string, number>; todos: readonly TodoItem[] };
      expect(output.todos).toEqual(sampleTodos);
      expect(output.counts.total).toBe(3);

      const state = context.require(TodoStateKey);
      expect(state.items).toEqual(sampleTodos);
    });

    it("clears the list when empty array provided", () => {
      const { context, result } = runInContext(() => executeTodoTool({ todos: [] }), {
        items: sampleTodos,
      });

      const output = result as { counts: Record<string, number>; todos: readonly TodoItem[] };
      expect(output.todos).toEqual([]);
      expect(output.counts.total).toBe(0);

      const state = context.require(TodoStateKey);
      expect(state.items).toEqual([]);
    });

    it("overwrites previous state", () => {
      const newTodos: TodoItem[] = [{ content: "New task", priority: "high", status: "pending" }];

      const { context } = runInContext(() => executeTodoTool({ todos: newTodos }), {
        items: sampleTodos,
      });

      const state = context.require(TodoStateKey);
      expect(state.items).toEqual(newTodos);
      expect(state.items).toHaveLength(1);
    });
  });

  describe("counts", () => {
    it("counts each status correctly", () => {
      const todos: TodoItem[] = [
        { content: "a", priority: "high", status: "pending" },
        { content: "b", priority: "high", status: "pending" },
        { content: "c", priority: "medium", status: "in_progress" },
        { content: "d", priority: "low", status: "completed" },
        { content: "e", priority: "low", status: "completed" },
        { content: "f", priority: "low", status: "completed" },
        { content: "g", priority: "medium", status: "cancelled" },
      ];

      const { result } = runInContext(() => executeTodoTool({ todos }));

      const output = result as { counts: Record<string, number> };
      expect(output.counts).toEqual({
        cancelled: 1,
        completed: 3,
        in_progress: 1,
        pending: 2,
        total: 7,
      });
    });
  });
});

describe("getTodoCompactionMessage", () => {
  function callHook(state: TodoState | undefined): ModelMessage | undefined {
    const ctx = new ContextContainer();
    if (state !== undefined) {
      ctx.set(TodoStateKey, state);
    }
    return contextStorage.run(ctx, () => getTodoCompactionMessage());
  }

  it("returns a summary message for a non-empty list", () => {
    const message = callHook({
      items: [
        { content: "Fix bug", priority: "high", status: "completed" },
        { content: "Write tests", priority: "medium", status: "pending" },
        { content: "Cancelled task", priority: "low", status: "cancelled" },
      ],
    });

    expect(message).toBeDefined();
    const text = String(message?.content ?? "");
    expect(text).toContain("[Your task list was preserved");
    expect(text).toContain("[x] [high] Fix bug");
    expect(text).toContain("[ ] [medium] Write tests");
    expect(text).toContain("[-] [low] Cancelled task");
  });

  it("returns undefined for an empty list", () => {
    expect(callHook({ items: [] })).toBeUndefined();
  });

  it("returns undefined when no state has been set", () => {
    expect(callHook(undefined)).toBeUndefined();
  });
});
