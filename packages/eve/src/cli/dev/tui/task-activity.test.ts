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
  renderTaskPanelRows(entries, { width, maxRows, theme, nowMs: 12_000, pulse: "▪" }).map(stripAnsi);

describe("live task panel", () => {
  it("keeps purpose separate from activity and flattens deeper ownership paths", () => {
    const rows = render([task("researcher", [task("analyst", [task("download")])])]);
    expect(rows).toEqual([
      "  ▪ Working · 3 tasks",
      "    researcher · Find Alice's notes",
      "      Starting · 12s",
      "    └ analyst · Find Alice's notes",
      "        Starting · 12s",
      "    └ analyst → download · Find Alice's notes",
      "        Starting · 12s",
    ]);
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
    expect(rows).toHaveLength(6);
    expect(rows.join("\n")).toContain("Needs your approval: run command");
    expect(rows.at(-1)).toContain("4 more working");
    expect(rows.join("\n")).not.toContain("download ·");
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
