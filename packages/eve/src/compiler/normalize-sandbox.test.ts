import { describe, expect, it } from "vitest";

import {
  compileSandboxDefinition,
  resolveParentSandboxSelector,
} from "#compiler/normalize-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION } from "#framework-sources/constants.js";

describe("resolveParentSandboxSelector", () => {
  it("recognizes a callback that returns parent.sandbox", async () => {
    const selector = ({ parent }: { parent: { sandbox: unknown } }) => parent.sandbox;

    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("supports marked rest-parameter callbacks without relying on function arity", async () => {
    const selector = defineSandbox((...args) => {
      if (args[0].parent === null) throw new Error("parent required");
      return args[0].parent.sandbox;
    });

    expect(selector.length).toBe(0);
    await expect(resolveParentSandboxSelector(selector, "invalid sandbox")).resolves.toBe(true);
  });

  it("rejects callbacks that return anything else", async () => {
    await expect(
      resolveParentSandboxSelector((_context: unknown) => ({ nope: true }), "invalid sandbox"),
    ).rejects.toThrow(
      "The callback passed to defineSandbox(...) must return parent.sandbox. Export a sandbox definition object for an independent sandbox.",
    );
  });

  it("reports authored callback errors", async () => {
    await expect(
      resolveParentSandboxSelector(() => {
        throw new Error("authored failure");
      }, "invalid sandbox"),
    ).rejects.toThrow(
      "The callback passed to defineSandbox(...) threw while selecting parent.sandbox: authored failure",
    );
  });

  it("leaves object definitions unchanged", async () => {
    await expect(resolveParentSandboxSelector({}, "invalid sandbox")).resolves.toBe(false);
  });
});

describe("compileSandboxDefinition", () => {
  it("serializes normalized lifecycle-hook presence", async () => {
    const definition = await compileSandboxDefinition(
      {
        logicalPath: "sandbox.ts",
        sourceId: "opaque:sandbox",
        sourceKind: "module",
      },
      {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "opaque:sandbox",
            registryId: "normalize-sandbox-test",
            revision: "v1",
          },
          logicalPath: "sandbox.ts",
          owner: { kind: "application" },
        },
        externalDependencyPlan: { entries: [] },
        moduleLoader: {
          async load() {
            return {
              default: {
                bootstrap: async () => undefined,
                onSession: async () => undefined,
              },
            };
          },
        },
      },
    );

    expect(definition).toEqual(expect.objectContaining({ hasBootstrap: true, hasOnSession: true }));
  });

  it("rotates source identity with the selected programmatic revision", async () => {
    const compile = async (revision: string) =>
      await compileSandboxDefinition(
        {
          logicalPath: "sandbox.ts",
          sourceId: "opaque:sandbox",
          sourceKind: "module",
        },
        {
          binding: {
            backing: {
              kind: "programmatic",
              moduleId: "opaque:sandbox",
              registryId: "normalize-sandbox-test",
              revision,
            },
            logicalPath: "sandbox.ts",
            owner: { kind: "application" },
          },
          externalDependencyPlan: { entries: [] },
          moduleLoader: {
            async load() {
              return { default: {} };
            },
          },
        },
      );

    const first = await compile("v1");
    const identical = await compile("v1");
    const revised = await compile("v2");

    expect(identical.sourceHash).toBe(first.sourceHash);
    expect(revised.sourceHash).not.toBe(first.sourceHash);
  });

  it("uses an explicit module semantic revision instead of a broader source revision", async () => {
    const compile = async (revision: string, semanticRevision: string) =>
      await compileSandboxDefinition(
        {
          logicalPath: "sandbox.ts",
          sourceId: "opaque:sandbox",
          sourceKind: "module",
        },
        {
          binding: {
            backing: {
              kind: "programmatic",
              moduleId: "opaque:sandbox",
              registryId: "normalize-sandbox-test",
              revision,
              semanticRevision,
            },
            logicalPath: "sandbox.ts",
            owner: { kind: "application" },
          },
          externalDependencyPlan: { entries: [] },
          moduleLoader: {
            async load() {
              return { default: {} };
            },
          },
        },
      );

    const first = await compile("source-v1", FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION);
    const unrelatedSourceChange = await compile(
      "source-v2",
      FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION,
    );
    const sandboxChange = await compile(
      "source-v2",
      `${FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION}:next`,
    );

    expect(unrelatedSourceChange.sourceHash).toBe(first.sourceHash);
    expect(sandboxChange.sourceHash).not.toBe(first.sourceHash);
  });
});
