import type { ModelMessage } from "ai";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { TODO_COMPACTION_PRESERVATION_LABEL } from "#harness/compaction-prompt.js";
import type { TodoItem, TodoToolInput } from "#public/tools/todo.js";

// ---------------------------------------------------------------------------
// Durable context key
// ---------------------------------------------------------------------------

/**
 * Durable state for eve's todo primitive.
 */
export interface TodoState {
  readonly items: readonly TodoItem[];
}

export const TodoStateKey = new ContextKey<TodoState>("eve.todo");

function formatTodoSummary(state: TodoState): string | undefined {
  if (state.items.length === 0) return undefined;

  const lines = state.items.map((item) => {
    const check = item.status === "completed" ? "x" : item.status === "cancelled" ? "-" : " ";
    return `- [${check}] [${item.priority}] ${item.content}`;
  });

  return `${TODO_COMPACTION_PRESERVATION_LABEL}\n${lines.join("\n")}`;
}

/**
 * Builds the message that re-injects the current todo list after the harness
 * compacts message history, so the agent keeps its task list across
 * compaction. Returns `undefined` when there is no list to preserve.
 */
export function getTodoCompactionMessage(): ModelMessage | undefined {
  const state = loadContext().get(TodoStateKey);
  if (
    state === undefined ||
    !state.items.some((item) => item.status === "pending" || item.status === "in_progress")
  ) {
    return undefined;
  }
  const summary = formatTodoSummary(state);
  if (summary === undefined) return undefined;
  return { content: summary, role: "user" };
}

function formatTodoResult(state: TodoState): object {
  const { items } = state;

  const counts = {
    cancelled: 0,
    completed: 0,
    in_progress: 0,
    pending: 0,
    total: items.length,
  };

  for (const item of items) {
    counts[item.status]++;
  }

  return {
    counts,
    todos: items,
  };
}

/**
 * Executes eve's todo primitive.
 *
 * - Read: omit `todos` → returns the current list.
 * - Write: provide `todos` → replaces the entire list, returns the new list.
 *
 * Both paths return the same formatted output so the model always sees
 * the full current state.
 */
export function executeTodoTool(input: TodoToolInput): unknown {
  const ctx = loadContext();
  const { todos } = input ?? {};

  if (todos !== undefined) {
    const newState: TodoState = { items: [...todos] };
    ctx.set(TodoStateKey, newState);
    return formatTodoResult(newState);
  }

  const current = ctx.ensure(TodoStateKey, () => ({ items: [] }));
  return formatTodoResult(current);
}
