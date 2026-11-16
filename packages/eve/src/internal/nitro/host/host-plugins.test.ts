import { describe, expect, it } from "vitest";

import { resolveWorkflowModulePath } from "#internal/application/package.js";
import { createModulePathMatcher } from "#internal/nitro/host/host-plugins.js";

describe("createModulePathMatcher", () => {
  it("matches Windows module ids across separators, drive-letter case, and specifier forms", () => {
    const { match } = createModulePathMatcher(
      "C:\\app",
      ["C:\\app\\.eve\\workflow\\workflows.mjs", "C:\\app\\.eve\\workflow\\steps.mjs"],
      "win32",
    );

    expect(match("./workflows.mjs", "C:\\app\\.eve\\workflow\\workflows-handler.mjs")).toBe(
      "C:/app/.eve/workflow/workflows.mjs",
    );
    expect(match("./workflows.mjs", "c:/APP/.eve/workflow/workflows-handler.mjs")).not.toBeNull();
    expect(match("C:\\app\\.eve\\workflow\\steps.mjs")).not.toBeNull();
    expect(match("c:/App/.eve/Workflow/steps.mjs")).not.toBeNull();
    expect(match("file:///C:/app/.eve/workflow/steps.mjs?v=1")).not.toBeNull();
    expect(match("C:\\app\\.eve\\workflow\\other.mjs")).toBeNull();
    expect(match("zod")).toBeNull();
  });

  it("resolves drive-less Windows paths the same way for targets and importers", () => {
    const { match } = createModulePathMatcher(
      "/app",
      ["/app/.eve/workflow/workflows.mjs"],
      "win32",
    );

    expect(match("./workflows.mjs", "/app/.eve/workflow/workflows-handler.mjs")).not.toBeNull();
    expect(match("/app/.eve/workflow/workflows.mjs")).not.toBeNull();
  });

  it("compares POSIX paths case-sensitively and ignores drive-letter specifiers", () => {
    const { match } = createModulePathMatcher("/app", ["/app/.eve/workflow/steps.mjs"], "linux");

    expect(match("./steps.mjs", "/app/.eve/workflow/workflows.mjs")).toBe(
      "/app/.eve/workflow/steps.mjs",
    );
    expect(match("/app/.eve/Workflow/steps.mjs")).toBeNull();
    expect(match("C:/app/.eve/workflow/steps.mjs")).toBeNull();
  });

  it("filters each Windows target in the form the matcher resolves it to", () => {
    for (const target of [
      "C:\\app\\agent\\..\\agent\\steps\\add.ts",
      "C:\\app\\agent\\steps\\.\\add.ts",
      "c:/app/agent/steps/add.ts",
      "/app/agent/steps/add.ts",
    ]) {
      const { idFilter, match } = createModulePathMatcher("C:\\app", [target], "win32");
      const id = match(target);

      expect(id, target).not.toBeNull();
      expect(idFilter.test(id!), `${target} resolved to ${id}`).toBe(true);
      expect(idFilter.test(`${id!.toUpperCase()}?v=1`), target).toBe(true);
    }
  });

  it("admits every specifier it matches and no path whose last segment names no target", () => {
    const matchers = {
      linux: createModulePathMatcher(
        "/app",
        [
          "/app/.eve/workflow/steps.mjs",
          "/app/.eve-runtime.mjs",
          "/app/agent/lib",
          resolveWorkflowModulePath("workflow/errors"),
        ],
        "linux",
      ),
      win32: createModulePathMatcher(
        "C:\\app",
        ["C:\\app\\.eve\\workflow\\steps.mjs", "C:\\app\\agent\\lib"],
        "win32",
      ),
    };
    const handler = "/app/.eve/workflow/workflows-handler.mjs";
    const winHandler = "C:\\app\\.eve\\workflow\\workflows-handler.mjs";
    // Rolldown filters see `/` separators; handlers see the specifier as written.
    const admitted = (platform: keyof typeof matchers, specifier: string) =>
      [specifier, specifier.replaceAll("\\", "/")].map((id) =>
        matchers[platform].specifierFilter.some((pattern) => pattern.test(id)),
      );

    const matched: [keyof typeof matchers, string, string?][] = [
      ["linux", "./steps.mjs", handler],
      ["linux", "/app/.eve/workflow/steps.mjs"],
      ["linux", "./steps.mjs?v=1", handler],
      ["linux", "./steps.mjs#hash", handler],
      ["linux", "../../.eve/workflow/steps.mjs", handler],
      ["linux", "./workflow\\steps.mjs", "/app/.eve/index.mjs"],
      ["linux", ".eve-runtime.mjs", "/app/agent.ts"],
      ["linux", "..", "/app/agent/lib/tools/add.ts"],
      ["linux", ".", "/app/agent/lib/add.ts"],
      ["linux", "./lib/", "/app/agent/index.ts"],
      ["linux", "file:///app/.eve/workflow/st%65ps.mjs"],
      ["linux", "workflow/errors"],
      ["win32", ".\\steps.mjs", winHandler],
      ["win32", "..\\workflow\\steps.mjs?v=1", winHandler],
      ["win32", "c:/APP/.eve/Workflow/STEPS.MJS"],
      ["win32", "\\app\\.eve\\workflow\\steps.mjs"],
      ["win32", "..", "C:\\app\\agent\\lib\\tools\\add.ts"],
      ["win32", "file:///C:/app/.eve/workflow/st%65ps.mjs?v=1"],
    ];
    for (const [platform, specifier, importer] of matched) {
      expect(matchers[platform].match(specifier, importer), specifier).not.toBeNull();
      expect(admitted(platform, specifier), specifier).toEqual([true, true]);
    }

    const unmatched: [keyof typeof matchers, string, string?][] = [
      ["linux", "./other.mjs", handler],
      ["linux", "./steps.mjs/other.mjs", handler],
      ["linux", "/app/.eve/workflow/steps.mjs.map"],
      ["win32", "C:\\app\\.eve\\workflow\\other.mjs"],
    ];
    for (const [platform, specifier, importer] of unmatched) {
      expect(matchers[platform].match(specifier, importer), specifier).toBeNull();
      expect(admitted(platform, specifier), specifier).toEqual([false, false]);
    }
  });
});
