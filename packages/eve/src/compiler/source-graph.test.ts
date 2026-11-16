import { describe, expect, it, vi } from "vitest";

import { memoizeModuleNamespaceFactories } from "#compiler/source-graph.js";
import { materializeAuthoredModuleExport } from "#internal/authored-module.js";

describe("memoizeModuleNamespaceFactories", () => {
  it("memoizes definition factories within one module namespace", async () => {
    const factory = vi.fn(() => ({ instance: Symbol("definition") }));
    const firstNamespace = memoizeModuleNamespaceFactories({ default: factory });
    const secondNamespace = memoizeModuleNamespaceFactories({ default: factory });

    const first = await materializeAuthoredModuleExport(firstNamespace.default as () => unknown);
    const repeated = await materializeAuthoredModuleExport(firstNamespace.default as () => unknown);
    const second = await materializeAuthoredModuleExport(secondNamespace.default as () => unknown);

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not memoize calls that pass arguments", async () => {
    const exported = vi.fn((value?: string) => value ?? { instance: Symbol("definition") });
    const namespace = memoizeModuleNamespaceFactories({ default: exported });
    const callable = namespace.default as (value?: string) => unknown;

    const first = await materializeAuthoredModuleExport(callable);
    const repeated = await materializeAuthoredModuleExport(callable);

    expect(repeated).toBe(first);
    expect(callable("first")).toBe("first");
    expect(callable("second")).toBe("second");
    expect(exported).toHaveBeenCalledTimes(3);
  });
});
