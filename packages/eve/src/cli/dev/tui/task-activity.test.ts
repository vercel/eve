import { describe, expect, it } from "vitest";
import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import { renderTaskPanelRows, type TaskEntry } from "./task-activity.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });
const task = (name: string, children: readonly TaskEntry[] = []): TaskEntry => ({
  callId: name,
  kind: "agent",
  name,
  toolName: name,
  input: {},
  label: undefined,
  purpose: "Find Alice's notes",
  startedAtMs: 0,
  childTools: new Map(),
  children,
});
const render = (entries: readonly TaskEntry[], width = 80, maxRows = 9) =>
  renderTaskPanelRows(entries, { width, maxRows, theme, nowMs: 12_000 }).map(stripAnsi);

describe("live task panel", () => {
  it("keeps purpose separate from activity and flattens deeper ownership paths", () => {
    const rows = render([task("researcher", [task("analyst", [task("download")])])]);
    expect(rows[0]).toMatch(/^─+ Working · 3 tasks ──$/);
    expect(visibleLength(rows[0]!)).toBe(80);
    expect(rows.slice(1, -1)).toEqual([
      "  researcher",
      "    Starting · 12s",
      "  └ analyst",
      "      Starting · 12s",
      "  └ analyst → download",
      "      Starting · 12s",
    ]);
    expect(rows.at(-1)).toBe("─".repeat(80));
    expect(rows.join("\n")).not.toContain("Find Alice's notes");
  });

  it("bounds fan-out and keeps nested approvals visible ahead of ordinary work", () => {
    const approval = task("reviewer");
    approval.childTools.set("approve", {
      kind: "tool",
      title: "run command",
      status: "approval",
      live: false,
    });
    const rows = render(
      [
        task("researcher", [task("download"), task("index")]),
        task("writer"),
        task("supervisor", [approval]),
      ],
      80,
      6,
    );
    expect(rows).toHaveLength(5);
    expect(rows.join("\n")).toContain("Needs your approval: run command");
    expect(rows.at(-2)).toContain("5 more working");
    expect(rows.join("\n")).not.toContain("download ·");
  });

  it("keeps turn status inside the drawer and includes it in the panel's row budget", () => {
    const rows = renderTaskPanelRows([task("researcher")], {
      width: 80,
      maxRows: 5,
      theme,
      nowMs: 12_000,
      turnStatus: "Waiting for researcher (16s)",
    }).map(stripAnsi);
    expect(rows).toHaveLength(5);
    expect(rows.slice(-2)).toEqual(["  Waiting for researcher (16s)", "─".repeat(80)]);
    expect(rows[1]).toBe("  researcher");
  });

  it("fits narrow terminals and small row budgets without retaining an empty panel", () => {
    expect(render([])).toEqual([]);
    for (const width of [1, 12, 28]) {
      const rows = render([task("a-long-task-name", [task("nested")])], width, 2);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(rows.every((row) => visibleLength(row) <= width)).toBe(true);
    }
  });
});
