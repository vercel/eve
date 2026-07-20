import { describe, expect, it } from "vitest";

import {
  allTodoItemsSettled,
  readTodoToolItems,
  renderFinishedTodoRows,
  renderTodoPanelRows,
  type TodoPanelItem,
} from "./todo-panel.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });

function render(items: readonly TodoPanelItem[], working = true, pulse = "▪"): string[] {
  return renderTodoPanelRows({ items, width: 60, theme, working, pulse }).map(stripAnsi);
}

describe("readTodoToolItems", () => {
  it("parses a replacement write into panel items", () => {
    expect(
      readTodoToolItems("todo", {
        todos: [
          { content: "one", status: "completed", priority: "high" },
          { content: "two", status: "in_progress", priority: "low" },
        ],
      }),
    ).toEqual([
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
    ]);
  });

  it("recognizes namespaced todo tools", () => {
    expect(readTodoToolItems("eve.todo", { todos: [{ content: "x", status: "pending" }] })).toEqual(
      [{ content: "x", status: "pending" }],
    );
  });

  it("returns undefined for read-only calls and other tools", () => {
    expect(readTodoToolItems("todo", {})).toBeUndefined();
    expect(readTodoToolItems("todo", undefined)).toBeUndefined();
    expect(readTodoToolItems("bash", { todos: [] })).toBeUndefined();
  });

  it("rejects malformed items rather than rendering a partial list", () => {
    expect(readTodoToolItems("todo", { todos: [{ content: 4, status: "pending" }] })).toBe(
      undefined,
    );
    expect(readTodoToolItems("todo", { todos: [{ content: "x", status: "later" }] })).toBe(
      undefined,
    );
  });

  it("keeps only the first line of a multi-line task", () => {
    expect(readTodoToolItems("todo", { todos: [{ content: "a\nb", status: "pending" }] })).toEqual([
      { content: "a", status: "pending" },
    ]);
  });
});

describe("allTodoItemsSettled", () => {
  it("treats completed and cancelled as terminal", () => {
    expect(
      allTodoItemsSettled([
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
      ]),
    ).toBe(true);
    expect(
      allTodoItemsSettled([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ]),
    ).toBe(false);
  });
});

describe("renderFinishedTodoRows", () => {
  it("checks every item on the rail and closes with Done", () => {
    const rows = renderFinishedTodoRows(
      [
        { content: "scope the review", status: "completed" },
        { content: "run the checks", status: "completed" },
        { content: "optional pass", status: "cancelled" },
      ],
      60,
      theme,
    ).map(stripAnsi);

    expect(rows).toEqual([
      "  ✓ Todo",
      "  │ ✓ scope the review",
      "  │ ✓ run the checks",
      "  │ ⨯ optional pass",
      "  └ Done",
    ]);
  });
});

describe("renderTodoPanelRows", () => {
  it("rails settled items and closes the rail at the active item", () => {
    const rows = render([
      { content: "theme glyphs", status: "completed" },
      { content: "setup verbiage", status: "completed" },
      { content: "status line", status: "in_progress" },
      { content: "keep blue", status: "pending" },
      { content: "root menu", status: "pending" },
    ]);

    expect(rows).toEqual([
      "  ▪ Todo",
      "  │ ✓ theme glyphs",
      "  │ ✓ setup verbiage",
      "  └ ⏺ status line",
      "    ○ keep blue",
      "    ○ root menu",
    ]);
  });

  it("holds the header steady while only the active item pulses", () => {
    const rows = render(
      [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ],
      true,
      " ",
    );

    // Off-beat frame: the header mark stays, the active item's dot blinks.
    expect(rows[0]).toBe("  ▪ Todo");
    expect(rows[2]).toBe("  └   b");
  });

  it("shows settled progress instead of the pulse while the prompt is idle", () => {
    const rows = render(
      [
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
        { content: "c", status: "pending" },
      ],
      false,
    );

    expect(rows[0]).toBe("  ▪ 2/3 tasks");
    expect(rows[1]).toBe("  │ ✓ a");
    expect(rows[2]).toBe("  │ ⨯ b");
    expect(rows[3]).toBe("  └ ○ c");
  });

  it("clips rows to the panel width", () => {
    const rows = renderTodoPanelRows({
      items: [{ content: "x".repeat(120), status: "pending" }],
      width: 24,
      theme,
      working: true,
      pulse: "▪",
    });
    for (const row of rows) {
      expect(stripAnsi(row).length).toBeLessThanOrEqual(24);
    }
  });
});
