import { describe, expect, it } from "vitest";

import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  formatChangeDetectedLogLine,
} from "#internal/nitro/host/dev-watcher-log.js";

import { ingestLog } from "./logs.js";

const APP_ROOT = "/app";

describe("ingestLog", () => {
  it.each([
    { mode: "none", level: "error", shown: false },
    { mode: "error", level: "error", shown: true },
    { mode: "error", level: "warn", shown: false },
    { mode: "warn", level: "warn", shown: true },
    { mode: "debug", level: "debug", shown: true },
    { mode: "debug", level: undefined, shown: false },
    { mode: "all", level: undefined, shown: true },
  ] as const)("filters a $level line under $mode", ({ mode, level, shown }) => {
    const { blocks } = ingestLog({ source: "stderr", level, text: "disk is full" }, { mode });
    expect(blocks.length > 0).toBe(shown);
  });

  it("turns rebuild lines into build phases instead of transcript lines", () => {
    const change = formatChangeDetectedLogLine(APP_ROOT, [
      { event: "change", path: `${APP_ROOT}/agent/tools/weather.ts` },
    ]);
    expect(ingestLog({ source: "stdout", text: change }, { mode: "all" })).toEqual({
      blocks: [],
      build: { phase: "building", summary: "tools/weather.ts changed" },
    });
    expect(
      ingestLog({ source: "stdout", text: AUTHORED_ARTIFACTS_UPDATED_LOG_LINE }, { mode: "all" }),
    ).toEqual({ blocks: [], build: { phase: "complete" } });
  });

  it("commits a failed rebuild as an error even when logs are hidden", () => {
    const ingest = ingestLog(
      { source: "stderr", level: "error", text: "[eve:dev] rebuild failed: bad syntax" },
      { mode: "none" },
    );
    expect(ingest.build).toEqual({ phase: "failed" });
    expect(ingest.blocks).toMatchObject([
      { kind: "log", logLevel: "error", body: "[eve:dev] rebuild failed: bad syntax" },
    ]);
  });

  it("collapses a long stderr dump to the diagnostics file unless all logs show", () => {
    const dump = ["TypeError: boom", ...Array.from({ length: 20 }, (_, i) => `  at f${i}`)].join(
      "\n",
    );
    const entry = { source: "stderr", level: "error", text: dump } as const;
    const collapsed = ingestLog(entry, { mode: "error", diagnosticsPath: "diag.jsonl" });
    expect(collapsed.blocks[0]?.body).toContain("details: diag.jsonl");
    const full = ingestLog(entry, { mode: "all", diagnosticsPath: "diag.jsonl" });
    expect(full.blocks[0]?.body).toBe(dump);
  });
});
