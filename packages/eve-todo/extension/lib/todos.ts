import { z } from "zod";

export const MAX_TODOS = 50;
export const MAX_CONTENT_LENGTH = 500;

export const todoStatus = z.enum(["pending", "in_progress", "completed", "cancelled"]);

export const todoItem = z.strictObject({
  content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH).describe("What the step does."),
  status: todoStatus.describe(
    "pending, in_progress (keep one at a time), completed, or cancelled when dropped.",
  ),
});

export const todoList = z.array(todoItem).max(MAX_TODOS);

export type TodoStatus = z.infer<typeof todoStatus>;
export type TodoItem = z.infer<typeof todoItem>;

const MARKS: Record<TodoStatus, string> = {
  cancelled: "[-]",
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

export function isOpen(item: TodoItem): boolean {
  return item.status === "pending" || item.status === "in_progress";
}

/** The list as the write tool reports it. */
export function summarize(items: readonly TodoItem[]) {
  const counts = { cancelled: 0, completed: 0, in_progress: 0, pending: 0, total: items.length };
  for (const item of items) counts[item.status]++;
  return { counts, todos: items };
}

/**
 * The instruction that shows the list, or `null` once nothing is open. A finished list says
 * nothing, so an old checklist can't read as work still to do.
 */
export function render(items: readonly TodoItem[]): string | null {
  if (!items.some(isOpen)) return null;
  const lines = items.map((item) => `${MARKS[item.status]} ${escape(item.content)}`);
  return [
    "<todos>",
    ...lines,
    "</todos>",
    "This is your checklist for the current task. Keep it current: rewrite the whole list when you start, finish, or drop a step, with one step in_progress at a time.",
  ].join("\n");
}

/** One line per item, with no way to close the tag. */
function escape(content: string): string {
  return content.replaceAll(/\s+/gu, " ").replaceAll("<", "&lt;");
}
