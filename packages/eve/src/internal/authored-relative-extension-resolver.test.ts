import { beforeEach, describe, expect, it, vi } from "vitest";

import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";

const fsMocks = vi.hoisted(() => ({
  realpathSync: vi.fn((path: string) => path),
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  ...fsMocks,
}));

type ResolveIdHook = {
  readonly filter: {
    readonly id: RegExp;
  };
  handler(source: string, importer: string | undefined): { readonly id: string } | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authored relative extension resolver", () => {
  it("filters non-path imports before the resolver hook runs", () => {
    const hook = getResolveIdHook();

    for (const source of [".hidden", "./local", "../parent", "/absolute", "C:\\absolute"]) {
      expect(hook.filter.id.test(source), source).toBe(true);
    }

    for (const source of ["zod", "@scope/package", "node:fs", "data:text/plain,hi", "file:///x"]) {
      expect(hook.filter.id.test(source), source).toBe(false);
    }
  });

  it("bounds an extensionless miss to 19 stat probes and reuses them", () => {
    fsMocks.statSync.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const hook = getResolveIdHook();

    expect(hook.handler("./missing", "/workspace/src/entry.ts")).toBeUndefined();
    expect(fsMocks.statSync).toHaveBeenCalledTimes(1 + RESOLVE_EXTENSIONS.length * 2);

    expect(hook.handler("./missing", "/workspace/src/other.ts")).toBeUndefined();
    expect(fsMocks.statSync).toHaveBeenCalledTimes(19);
  });

  it("discards probe results with the plugin instance", () => {
    const files = new Set(["/workspace/src/value.ts"]);
    fsMocks.statSync.mockImplementation((path) => {
      if (files.has(String(path))) {
        return { isFile: () => true };
      }

      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const firstHook = getResolveIdHook();
    expect(firstHook.handler("./value", "/workspace/src/entry.ts")).toEqual({
      id: "/workspace/src/value.ts",
    });

    files.delete("/workspace/src/value.ts");
    files.add("/workspace/src/value.tsx");

    expect(firstHook.handler("./value", "/workspace/src/entry.ts")).toEqual({
      id: "/workspace/src/value.ts",
    });
    const probesBeforeNextPlugin = fsMocks.statSync.mock.calls.length;

    const nextHook = getResolveIdHook();
    expect(nextHook.handler("./value", "/workspace/src/entry.ts")).toEqual({
      id: "/workspace/src/value.tsx",
    });
    expect(fsMocks.statSync.mock.calls.length).toBeGreaterThan(probesBeforeNextPlugin);
  });
});

function getResolveIdHook(): ResolveIdHook {
  const plugin = createAuthoredRelativeExtensionResolverPlugin({
    extensions: RESOLVE_EXTENSIONS,
  });
  return plugin.resolveId as ResolveIdHook;
}
