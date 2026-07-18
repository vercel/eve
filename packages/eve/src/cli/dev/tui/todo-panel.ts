/**
 * The pinned todo panel: pure parsing and rendering for the task list the
 * model maintains through the framework `todo` tool. The tool writes the
 * whole list on every call, so the panel is driven entirely from tool-call
 * inputs — no protocol addition and no durable client state. The renderer
 * owns lifecycle (when a call updates the panel, when the finished list
 * commits to the transcript); this module only reads inputs and paints rows.
 */

import type { Theme } from "./theme.js";
import { toolBaseName } from "./tool-presentation.js";
import { clipVisible, stripTerminalControls } from "./terminal-text.js";

/** One panel row parsed from the `todo` tool's replacement-write input. */
export interface TodoPanelItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
}

const TODO_STATUSES: ReadonlySet<TodoPanelItem["status"]> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * Extracts the panel items from a tool call when — and only when — it is a
 * `todo` replacement write. Read-only calls (no `todos`) and malformed items
 * return `undefined` so they fall through to the ordinary tool block.
 */
export function readTodoToolItems(toolName: string, input: unknown): TodoPanelItem[] | undefined {
  if (toolBaseName(toolName) !== "todo") return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const todos = (input as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return undefined;

  const items: TodoPanelItem[] = [];
  for (const todo of todos) {
    if (todo === null || typeof todo !== "object" || Array.isArray(todo)) return undefined;
    const record = todo as Record<string, unknown>;
    const content = record["content"];
    const status = record["status"];
    if (typeof content !== "string") return undefined;
    if (typeof status !== "string" || !TODO_STATUSES.has(status as TodoPanelItem["status"])) {
      return undefined;
    }
    items.push({
      content: firstLine(stripTerminalControls(content)),
      status: status as TodoPanelItem["status"],
    });
  }
  return items;
}

/** True when every item reached a terminal status (completed or cancelled). */
export function allTodoItemsSettled(items: readonly TodoPanelItem[]): boolean {
  return items.every((item) => item.status === "completed" || item.status === "cancelled");
}

export interface TodoPanelRowsInput {
  readonly items: readonly TodoPanelItem[];
  readonly width: number;
  readonly theme: Theme;
  /** True while the turn is running: pulses the header and the active item. */
  readonly working: boolean;
  /** Current shared pulse frame (the glyph, or a space on the off beat). */
  readonly pulse: string;
}

/**
 * Paints the pinned panel. Settled items ride a `│` rail under the header;
 * the first unsettled item closes the rail with `└` and everything after
 * hangs indented — the list reads as progress flowing through the corner.
 */
export function renderTodoPanelRows(input: TodoPanelRowsInput): string[] {
  const { items, width, theme } = input;
  const c = theme.colors;
  const g = theme.glyph;

  const settled = items.filter(
    (item) => item.status === "completed" || item.status === "cancelled",
  ).length;
  const header = input.working
    ? `${c.yellow(input.pulse)} ${c.dim(`Working${g.ellipsis}`)}`
    : `${c.gray(g.square)} ${c.dim(`${settled}/${items.length} tasks`)}`;

  const rows = [header];
  let railClosed = false;
  for (const item of items) {
    const isSettled = item.status === "completed" || item.status === "cancelled";
    let rail: string;
    if (railClosed) {
      rail = " ";
    } else if (isSettled) {
      rail = c.dim(g.rule);
    } else {
      rail = c.dim(g.corner);
      railClosed = true;
    }
    rows.push(`${rail} ${todoItemBody(item, input, theme)}`);
  }
  return rows.map((row) => clipVisible(row, width));
}

function todoItemBody(item: TodoPanelItem, input: TodoPanelRowsInput, theme: Theme): string {
  const c = theme.colors;
  const g = theme.glyph;
  switch (item.status) {
    case "completed":
      return `${c.green(g.dotFilled)} ${c.dim(item.content)}`;
    case "cancelled":
      return `${c.red(g.dotFilled)} ${c.dim(item.content)}`;
    case "in_progress": {
      // The active item pulses on the shared beat while the turn runs, and
      // holds a steady mark between turns so the panel never looks dead.
      const mark = input.working
        ? input.pulse.trim().length > 0
          ? g.dotActive
          : " "
        : g.dotActive;
      return `${c.yellow(mark)} ${item.content}`;
    }
    case "pending":
      return `${c.dim(g.reasoning)} ${c.dim(item.content)}`;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u, 1)[0] ?? "";
}
