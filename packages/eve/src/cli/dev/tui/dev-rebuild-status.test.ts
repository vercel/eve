import { describe, expect, it } from "vitest";

import { formatDevRebuildStatus, summarizeChangedFiles } from "./dev-rebuild-status.js";

describe("summarizeChangedFiles", () => {
  it("shortens an absolute path to its last two components", () => {
    const summary = summarizeChangedFiles(
      [{ event: "change", path: "/Users/me/wrk/eve/src/cli/dev/tui/setup-panel.ts" }],
      0,
    );
    expect(summary).toBe("tui/setup-panel.ts changed");
  });

  it("keeps an already-short relative path as-is", () => {
    expect(summarizeChangedFiles([{ event: "change", path: "agent/agent.ts" }], 0)).toBe(
      "agent/agent.ts changed",
    );
    expect(summarizeChangedFiles([{ event: "change", path: "package.json" }], 0)).toBe(
      "package.json changed",
    );
  });

  it("collapses duplicate paths reported under different events", () => {
    const summary = summarizeChangedFiles(
      [
        { event: "add", path: "agent/tools/lookup.ts" },
        { event: "change", path: "agent/tools/lookup.ts" },
      ],
      0,
    );
    expect(summary).toBe("tools/lookup.ts changed");
  });

  it("caps the path list and folds the rest into the watcher's remainder", () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      event: "change",
      path: `agent/file-${index}.ts`,
    }));
    expect(summarizeChangedFiles(events, 2)).toBe(
      "agent/file-0.ts, agent/file-1.ts, agent/file-2.ts +4 more changed",
    );
  });

  it("picks the verb from the event kinds", () => {
    expect(summarizeChangedFiles([{ event: "add", path: "agent/new.ts" }], 0)).toBe(
      "agent/new.ts added",
    );
    expect(summarizeChangedFiles([{ event: "unlink", path: "agent/old.ts" }], 0)).toBe(
      "agent/old.ts removed",
    );
    expect(
      summarizeChangedFiles(
        [
          { event: "add", path: "agent/new.ts" },
          { event: "unlink", path: "agent/old.ts" },
        ],
        0,
      ),
    ).toBe("agent/new.ts, agent/old.ts changed");
  });
});

describe("formatDevRebuildStatus", () => {
  it("renders each lifecycle phase as one short clause", () => {
    expect(formatDevRebuildStatus("agent/agent.ts changed", "rebuilding")).toBe(
      "agent/agent.ts changed · rebuilding…",
    );
    expect(formatDevRebuildStatus("agent/agent.ts changed", "rebuilt")).toBe(
      "agent/agent.ts changed · rebuilt",
    );
    expect(formatDevRebuildStatus("agent/agent.ts changed", "reloading")).toBe(
      "agent/agent.ts changed · reloading server…",
    );
  });
});
