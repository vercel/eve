import { describe, expect, it } from "vitest";

import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
  formatChangeDetectedLogLine,
  parseDevRebuildLogLine,
} from "./dev-watcher-log.js";

describe("formatChangeDetectedLogLine", () => {
  it("displays paths inside the app root relative to it", () => {
    const line = formatChangeDetectedLogLine("/app", [
      { event: "change", path: "/app/agent/agent.ts" },
    ]);
    expect(line).toBe(
      "[eve:dev] change detected (1 event: change agent/agent.ts), rebuilding authored artifacts...",
    );
  });

  it("keeps paths outside the app root absolute", () => {
    const line = formatChangeDetectedLogLine("/app", [
      { event: "change", path: "/elsewhere/src/prompter.ts" },
    ]);
    expect(line).toContain("change /elsewhere/src/prompter.ts");
  });

  it("caps the displayed list and reports the remainder", () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      event: "change",
      path: `/app/file-${index}.ts`,
    }));
    const line = formatChangeDetectedLogLine("/app", events);
    expect(line).toContain("8 events:");
    expect(line).toContain("+2 more");
  });
});

describe("parseDevRebuildLogLine", () => {
  it("round-trips a single-event line through the formatter", () => {
    const line = formatChangeDetectedLogLine("/app", [
      { event: "change", path: "/app/agent/agent.ts" },
    ]);
    expect(parseDevRebuildLogLine(line)).toEqual({
      kind: "rebuilding",
      events: [{ event: "change", path: "agent/agent.ts" }],
      more: 0,
    });
  });

  it("round-trips a capped multi-event line including the remainder", () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      event: "change",
      path: `/app/file-${index}.ts`,
    }));
    const parsed = parseDevRebuildLogLine(formatChangeDetectedLogLine("/app", events));
    expect(parsed).toMatchObject({ kind: "rebuilding", more: 2 });
    expect(parsed?.kind === "rebuilding" ? parsed.events : []).toHaveLength(6);
  });

  it("recognizes the lifecycle outcome lines", () => {
    expect(parseDevRebuildLogLine(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE)).toEqual({
      kind: "rebuilt",
    });
    expect(parseDevRebuildLogLine(STRUCTURAL_RELOAD_LOG_LINE)).toEqual({ kind: "reloading" });
    expect(parseDevRebuildLogLine("[eve:dev] rebuild failed: boom")).toEqual({
      kind: "failed",
      message: "boom",
    });
    expect(parseDevRebuildLogLine("[eve:dev] rebuild queue error: queue boom")).toEqual({
      kind: "failed",
      message: "queue boom",
    });
  });

  it("returns undefined for every other log line", () => {
    expect(parseDevRebuildLogLine("weather lookup { city: 'NY' }")).toBeUndefined();
    expect(parseDevRebuildLogLine("")).toBeUndefined();
  });
});
