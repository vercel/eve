import { describe, expect, it } from "vitest";

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
});
