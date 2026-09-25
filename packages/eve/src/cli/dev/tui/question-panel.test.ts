import { describe, expect, it } from "vitest";

import { EMPTY_LINE, type LineState } from "./line-editor.js";
import { renderQuestionPanel } from "./question-panel.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });

function render(state: {
  cursor: number;
  allowFreeform?: boolean;
  editor?: LineState;
  caretVisible?: boolean;
}): string[] {
  return renderQuestionPanel(
    {
      prompt: "What type of options would you like to see?",
      options: [
        { id: "tools", label: "Available Tools", description: "See 4 tools I can use" },
        { id: "services", label: "Connected Services" },
      ],
      cursor: state.cursor,
      allowFreeform: state.allowFreeform ?? true,
      editor: state.editor ?? EMPTY_LINE,
      caretVisible: state.caretVisible ?? true,
    },
    theme,
    60,
  ).map(stripAnsi);
}

describe("renderQuestionPanel", () => {
  it("renders a prompt and options for its enclosing drawer", () => {
    const rows = render({ cursor: 0 });

    expect(rows[0]).toBe("  What type of options would you like to see?");
    expect(rows).toContain("  What type of options would you like to see?");
    expect(rows.find((row) => row.includes("Available Tools"))).toBe("     Available Tools");
    expect(rows).toContain("     See 4 tools I can use");
    expect(rows).toContain("     Connected Services");
    expect(rows[1]).toBe("");
    expect(rows.at(-1)).toBe("     Type your own answer…");
  });

  it("marks only the cursor row with the pointer and enter badge", () => {
    const rows = render({ cursor: 1 });
    const selected = rows.find((row) => row.includes("Connected Services"));

    expect(selected).toBe("     Connected Services");
    expect(selected).not.toContain("↵");
    expect(rows.find((row) => row.includes("Available Tools"))).not.toContain("›");
  });

  it("keeps every row's number and label in the same columns as the cursor moves", () => {
    const columnsOf = (rows: string[]) =>
      rows
        .filter((row) => row.includes("Connected Services"))
        .map((row) => row.indexOf("Connected Services"));

    // Selected and unselected variants of the same row must not drift.
    expect(columnsOf(render({ cursor: 1 }))).toEqual(columnsOf(render({ cursor: 0 })));
  });

  it("turns the freeform placeholder into an inline editor when focused", () => {
    expect(render({ cursor: 0 }).at(-1)).toBe("     Type your own answer…");

    const focused = render({ cursor: 2 });
    expect(focused.at(-1)).toBe("     Type your own answer…");

    // A draft remains in the inline field when the cursor moves away.
    const drafted = render({ cursor: 0, editor: { text: "custom", cursor: 6 } });
    expect(drafted.at(-1)).toBe("     custom");
  });

  it("splits a multi-paragraph prompt into real rows before wrapping", () => {
    const rows = renderQuestionPanel(
      {
        prompt: "Pick an idea:\n\n- **Coding** – learn a framework\n- **Data** – analytics",
        options: [{ id: "a", label: "Coding" }],
        cursor: 0,
        allowFreeform: false,
        editor: EMPTY_LINE,
        caretVisible: true,
      },
      theme,
      60,
    ).map(stripAnsi);

    // Every prompt paragraph is its own row — a row secretly holding
    // newlines breaks the live region's row accounting and leaks duplicate
    // frames into scrollback on repaint.
    expect(rows).toContain("  Pick an idea:");
    expect(rows).toContain("  - **Coding** – learn a framework");
    expect(rows).toContain("  - **Data** – analytics");
    expect(rows.every((row) => !row.includes("\n"))).toBe(true);
  });

  it("clips every row to the panel width", () => {
    for (const row of render({ cursor: 0 })) {
      expect(row.length).toBeLessThanOrEqual(60);
    }
  });
});
