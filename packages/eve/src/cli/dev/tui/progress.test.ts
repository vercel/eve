import { describe, expect, it } from "vitest";

import { createProgressSnapshot, reduceProgressBatch } from "#execution/session-progress.js";

import { activityMessages, buildTuiProgressRenderers, tuiActivityProgress } from "./progress.js";

const root = {
  id: "root:session:turn",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};
const child = {
  id: "work:session:turn:child",
  kind: "subagent" as const,
  name: "researcher",
  parentId: root.id,
  rootSessionId: "session",
  rootTurnId: "turn",
};

function snapshot() {
  return reduceProgressBatch(createProgressSnapshot(), {
    events: [
      { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
      { eventId: "child", kind: "work.started", startedAt: "2026-01-01T00:00:01Z", work: child },
      {
        action: {
          id: "action:child:search",
          kind: "tool",
          name: "search",
          parentWorkId: child.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "search",
        kind: "action.started",
        startedAt: "2026-01-01T00:00:02Z",
      },
    ],
    version: 1,
  });
}

describe("TUI activity progress", () => {
  it("renders the same nested activity tree as a root-turn projection", () => {
    expect(activityMessages(snapshot())).toEqual(
      new Map([["turn", ["• Working", "  • researcher", "    • search"].join("\n")]]),
    );
  });

  it("updates one live artifact per root turn", () => {
    const updates: unknown[] = [];
    const renderer = buildTuiProgressRenderers([tuiActivityProgress()])[0]!;
    renderer.render({
      renderActivity: (update) => updates.push(update),
      snapshot: snapshot(),
      state: undefined,
    });
    expect(updates).toEqual([
      {
        live: true,
        rootTurnId: "turn",
        text: ["• Working", "  • researcher", "    • search"].join("\n"),
      },
    ]);
  });

  it("rejects renderers not made by the factory", () => {
    expect(() => buildTuiProgressRenderers([{ id: "tui.activity.v1" } as never])).toThrow(
      "TUI progress renderers must be created by an eve renderer factory.",
    );
  });
});
