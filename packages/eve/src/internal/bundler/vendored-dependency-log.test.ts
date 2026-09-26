import { describe, expect, it, vi } from "vitest";

import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";

function forwardedLogs(level: string, log: unknown): unknown[][] {
  const defaultHandler = vi.fn();
  onVendoredDependencyLog(level, log, defaultHandler);
  return defaultHandler.mock.calls;
}

describe("onVendoredDependencyLog", () => {
  it.each([
    ["a dependency module id", { id: "/app/node_modules/dep/index.js" }],
    ["a dependency source location", { loc: { file: "/repo/node_modules/fixture/index.js" } }],
    ["a Windows dependency path", { id: "C:\\app\\node_modules\\dep\\index.js" }],
    [
      "eve's generated vendor modules",
      { ids: ["/repo/packages/eve/.generated/compiled/gray-matter/index.js"] },
    ],
    [
      "eve's published vendor modules",
      { id: "/app/node_modules/eve/dist/src/compiled/gray-matter/index.js" },
    ],
  ])("drops a warning raised only by %s", (_, log) => {
    expect(forwardedLogs("warn", { message: "dependency detail", ...log })).toEqual([]);
  });

  it.each([
    ["an authored module", "warn", { id: "/app/agent/tools/evaluate.ts" }],
    [
      "a module that only resembles a vendor path",
      "warn",
      { ids: ["/app/agent/compiled/tool.ts", "/app/node_modules_backup/index.js"] },
    ],
    [
      "authored code alongside a dependency",
      "warn",
      {
        id: "/app/agent/tools/evaluate.ts",
        ids: [
          "/app/agent/tools/evaluate.ts",
          "/app/node_modules/eve/dist/src/compiled/vendor/index.js",
        ],
      },
    ],
    ["a module-less warning", "warn", { message: "unresolved entry" }],
    ["a plain-string warning", "warn", "unresolved entry"],
    ["a dependency error", "error", { id: "/app/node_modules/dep/index.js" }],
  ])("forwards %s", (_, level, log) => {
    expect(forwardedLogs(level, log)).toEqual([[level, log]]);
  });
});
