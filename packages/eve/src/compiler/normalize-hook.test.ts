import { describe, expect, it } from "vitest";

import { compileHookEntry } from "./normalize-hook.js";

describe("compileHookEntry", () => {
  it("derives the slug from the path-relative file location", () => {
    expect(
      compileHookEntry({
        logicalPath: "hooks/audit.ts",
        sourceId: "hooks/audit.ts",
        sourceKind: "module",
      }),
    ).toEqual({
      logicalPath: "hooks/audit.ts",
      slug: "audit",
      sourceId: "hooks/audit.ts",
      sourceKind: "module",
    });
  });

  it("preserves nested directory segments inside the slug", () => {
    expect(
      compileHookEntry({
        logicalPath: "hooks/auth/guard.ts",
        sourceId: "hooks/auth/guard.ts",
        sourceKind: "module",
      }).slug,
    ).toBe("auth/guard");
  });

  it("preserves an authored exportName when present", () => {
    expect(
      compileHookEntry({
        exportName: "guard",
        logicalPath: "hooks/auth.ts",
        sourceId: "hooks/auth.ts",
        sourceKind: "module",
      }).exportName,
    ).toBe("guard");
  });
});
