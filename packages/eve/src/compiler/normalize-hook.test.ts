import { describe, expect, it } from "vitest";

import type { HookSourceRef } from "#discover/manifest.js";
import { compileHookEntry } from "./normalize-hook.js";

function source(logicalPath: string, exportName?: string): HookSourceRef {
  const hookSource: HookSourceRef = {
    logicalPath,
    sourceId: logicalPath,
    sourceKind: "module",
  };
  if (exportName === undefined) {
    return hookSource;
  }
  return { ...hookSource, exportName };
}

async function compile(
  hookSource: HookSourceRef,
  value: unknown,
): ReturnType<typeof compileHookEntry> {
  return compileHookEntry(hookSource, {
    binding: {
      backing: {
        kind: "programmatic",
        moduleId: hookSource.sourceId,
        registryId: "normalize-hook-test",
        revision: "v1",
      },
      logicalPath: hookSource.logicalPath,
      owner: { kind: "application" },
    },
    moduleLoader: {
      async load() {
        return { [hookSource.exportName ?? "default"]: value };
      },
    },
  });
}

describe("compileHookEntry", () => {
  it("derives the slug from the path-relative file location", async () => {
    await expect(compile(source("hooks/audit.ts"), { events: {} })).resolves.toEqual({
      eventNames: [],
      logicalPath: "hooks/audit.ts",
      slug: "audit",
      sourceId: "hooks/audit.ts",
      sourceKind: "module",
    });
  });

  it("preserves nested directory segments inside the slug", async () => {
    await expect(compile(source("hooks/auth/guard.ts"), { events: {} })).resolves.toMatchObject({
      slug: "auth/guard",
    });
  });

  it("preserves an authored exportName when present", async () => {
    await expect(compile(source("hooks/auth.ts", "guard"), { events: {} })).resolves.toMatchObject({
      exportName: "guard",
    });
  });

  it("records sorted event names from callable handlers", async () => {
    await expect(
      compile(source("hooks/audit.ts"), {
        events: { "turn.started": () => {}, "session.started": () => {} },
      }),
    ).resolves.toMatchObject({ eventNames: ["session.started", "turn.started"] });
  });

  it("rejects non-callable handlers before serialization", async () => {
    await expect(
      compile(source("hooks/audit.ts"), { events: { "turn.started": "not callable" } }),
    ).rejects.toThrow("Expected the hook export");
  });

  it("requires the selected source binding before its export executes", async () => {
    let loaded = false;
    await expect(
      compileHookEntry(source("hooks/audit.ts"), {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "hooks/audit.ts",
            registryId: "normalize-hook-test",
            revision: "v1",
          },
          logicalPath: "hooks/other.ts",
          owner: { kind: "application" },
        },
        moduleLoader: {
          async load() {
            loaded = true;
            return { default: { events: {} } };
          },
        },
      }),
    ).rejects.toThrow('from binding "hooks/other.ts"');
    expect(loaded).toBe(false);
  });
});
