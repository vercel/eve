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
const render = (entries: readonly TaskEntry[], width = 80, maxRows = 11) =>
  renderTaskPanelRows(entries, { width, maxRows, theme, nowMs: 12_000 }).map(stripAnsi);

describe("live task panel", () => {
  it("labels subagents, groups their activity, and flattens deeper ownership paths", () => {
    const rows = render([task("researcher", [task("analyst", [task("download")])])]);
    expect(rows[0]).toMatch(/^── Working · 3 tasks ─+$/);
    expect(visibleLength(rows[0]!)).toBe(80);
    expect(rows.slice(2, -2)).toEqual([
      "  subagent(researcher) 12s",
      "  └ subagent(analyst) 12s",
      "  └ subagent(analyst) → subagent(download) 12s",
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
      7,
    );
    expect(rows).toHaveLength(7);
    expect(rows.join("\n")).toContain("Needs your approval: run command");
    expect(rows.at(-2)).toBe("");
    expect(rows.at(-3)).toContain("5 more working");
    expect(rows.join("\n")).not.toContain("download ·");
  });

  it("puts parent state and turn time in the header with breathing room around tasks", () => {
    const rows = renderTaskPanelRows([task("self-modification__agent")], {
      width: 80,
      maxRows: 6,
      theme,
      nowMs: 12_000,
      activity: "Waiting",
      turnElapsedMs: 16_000,
    }).map(stripAnsi);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^── Waiting · 1 task · 16s ─+$/);
    expect(rows[1]).toBe("");
    expect(rows[2]).toBe("  subagent(self-modification) 12s");
    expect(rows.slice(-2)).toEqual(["", "─".repeat(80)]);
    expect(rows.join("\n")).not.toContain("Waiting for");
  });

  it("retains the last command between calls instead of flashing Starting over it", () => {
    const entry = task("researcher");
    entry.childTools.set("read", {
      kind: "tool",
      title: "Read notes.md",
      status: "running",
      live: false,
    });
    expect(render([entry]).join("\n")).toContain("⎿ Read notes.md");
    entry.childTools.set("read", {
      kind: "tool",
      title: "Read notes.md",
      status: "done",
      live: false,
    });
    const settled = render([entry]).join("\n");
    expect(settled).toContain("subagent(researcher) 12s");
    expect(settled).toContain("⎿ Read notes.md");
    expect(settled).not.toContain("Starting");
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
