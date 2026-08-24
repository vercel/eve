import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeRule41FrameworkRegistryImportsFixture,
  analyzeRule41ManifestParseFixture,
  analyzeRule41ModuleNormalizerBindingFixture,
  analyzeRule43Fixture,
} from "./guard-invariants.mjs";

describe("Rule 41 framework registry import guard", () => {
  it("accepts only the registry contracts and framework-owned metadata", () => {
    assert.deepEqual(
      analyzeRule41FrameworkRegistryImportsFixture(`
        import { createFrameworkAgentSourceRegistry } from "#compiler/agent-source-registry.js";
        import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
        import { resolveFrameworkAgentSourceRevision } from "#framework-sources/revision.js";
        import { FRAMEWORK_AGENT_SOURCE_ID } from "./constants.js";
      `),
      [],
    );
  });

  it("rejects compiler wrappers and static definition imports", () => {
    assert.deepEqual(
      analyzeRule41FrameworkRegistryImportsFixture(`
        import { resolveFrameworkAgentSourceRevision } from "#compiler/framework-source-revision.js";
        import { defaultAgentConfig } from "./agent.js";
      `),
      ["#compiler/framework-source-revision.js", "./agent.js"],
    );
  });
});

describe("Rule 41 compiled manifest parse guard", () => {
  it("finds structural parses that skip relational validation", () => {
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(`
        import { compiledAgentManifestSchema } from "#compiler/manifest.js";
        export const manifest = compiledAgentManifestSchema.parse(value);
      `),
      ["direct-parse"],
    );
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(`
        import { compiledAgentManifestSchema } from "#compiler/manifest.js";
        export const manifest = compiledAgentManifestSchema.safeParse(value);
      `),
      ["unvalidated-safe-parse"],
    );
  });

  it("accepts safe parsing paired with the semantic validator", () => {
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(`
        import { compiledAgentManifestSchema } from "#compiler/manifest.js";
        import { assertSerializedCompiledAgentManifestSemantics } from "#compiler/compiled-manifest-validation.js";
        const parsed = compiledAgentManifestSchema.safeParse(value);
        if (parsed.success) assertSerializedCompiledAgentManifestSemantics(parsed.data);
      `),
      [],
    );
  });

  it("requires each safe-parse result to be validated in the same function", () => {
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(`
        import { compiledAgentManifestSchema } from "#compiler/manifest.js";
        import { assertSerializedCompiledAgentManifestSemantics } from "#compiler/compiled-manifest-validation.js";
        function parseOne(value) {
          const parsed = compiledAgentManifestSchema.safeParse(value);
          return parsed;
        }
        function validateOther(value) {
          const parsed = { data: value };
          assertSerializedCompiledAgentManifestSemantics(parsed.data);
        }
      `),
      ["unvalidated-safe-parse"],
    );
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(`
        import { compiledAgentManifestSchema } from "#compiler/manifest.js";
        import { assertSerializedCompiledAgentManifestSemantics } from "#compiler/compiled-manifest-validation.js";
        const first = compiledAgentManifestSchema.safeParse(one);
        const second = compiledAgentManifestSchema.safeParse(two);
        assertSerializedCompiledAgentManifestSemantics(first.data);
      `),
      ["unvalidated-safe-parse"],
    );
  });

  it("finds direct JSON casts to compiled manifests", () => {
    assert.deepEqual(
      analyzeRule41ManifestParseFixture(
        `const manifest = JSON.parse(source) as CompiledAgentManifest;`,
      ),
      ["unsafe-cast"],
    );
  });
});

describe("Rule 41 module normalizer binding guard", () => {
  it("finds every option shape that can omit a module binding", () => {
    assert.deepEqual(
      analyzeRule41ModuleNormalizerBindingFixture(`
        interface OptionalOptions {
          readonly binding?: CompiledModuleBinding;
        }
        interface UndefinedOptions {
          readonly binding: CompiledModuleBinding | undefined;
        }
        type PartialOptions = Partial<ModuleBackedDefinitionLoadOptions>;
      `),
      ["optional-binding", "optional-binding", "partial-options"],
    );
  });

  it("accepts required binding options and unrelated optional fields", () => {
    assert.deepEqual(
      analyzeRule41ModuleNormalizerBindingFixture(`
        interface Options {
          readonly binding: CompiledModuleBinding;
          readonly name?: string;
        }
        type ModuleOptions = Options & ModuleBackedDefinitionLoadOptions;
      `),
      [],
    );
  });
});

describe("Rule 43 kernel lifecycle guard", () => {
  it("finds raw inventory imports through aliases", () => {
    assert.deepEqual(
      analyzeRule43Fixture(`
        import { KERNEL_CAPABILITY_NAMES as nativeNames } from "#kernel/capabilities.js";
        export const copiedNames = nativeNames;
      `),
      ["raw-inventory"],
    );
  });

  it("finds imports of raw strategy accessors", () => {
    for (const accessor of [
      "getExecutableKernelCapabilityStrategy",
      "getKernelCapabilityStrategy",
    ]) {
      assert.deepEqual(
        analyzeRule43Fixture(`
          import { ${accessor} as readStrategy } from "#kernel/capabilities.js";
          export const leaked = readStrategy;
        `),
        ["raw-inventory"],
      );
    }
  });

  it("finds singleton array, Set, and Map registries", () => {
    for (const fixture of [
      `const capabilityRegistry = ["agent"];`,
      `const capabilityRegistry = new Set(["agent"]);`,
      `const capabilityRegistry = new Map([["agent", () => {}]]);`,
    ]) {
      assert.deepEqual(analyzeRule43Fixture(fixture), ["ad-hoc-registry"]);
    }
  });

  it("finds provider recovery maps outside the kernel inventory", () => {
    for (const fixture of [
      `const upstreamToolMapping = { web_search_20250305: "web_search" };`,
      `const providerToolRecovery = new Map([["web_search_20250305", "web_search"]]);`,
    ]) {
      assert.deepEqual(analyzeRule43Fixture(fixture), ["ad-hoc-registry"]);
    }
  });

  it("resolves computed object keys and local string aliases", () => {
    assert.deepEqual(
      analyzeRule43Fixture(`
        const AGENT = "agent";
        const capabilityHandlers = { [AGENT]: () => {} };
      `),
      ["ad-hoc-registry"],
    );
  });

  it("resolves registries inherited through spreads", () => {
    assert.deepEqual(
      analyzeRule43Fixture(`
        const baseHandlers = { agent: () => {} };
        const capabilityHandlers = { ...baseHandlers };
      `),
      ["ad-hoc-registry"],
    );
    assert.deepEqual(
      analyzeRule43Fixture(`
        const baseNames = ["agent"];
        const capabilityNames = [...baseNames];
      `),
      ["ad-hoc-registry"],
    );
  });

  it("finds aliased imported ordinary primitive calls in native modules", () => {
    assert.deepEqual(
      analyzeRule43Fixture(
        `
          import { defineTool as makeTool } from "#public/tools/index.js";
          const defineNativeTool = makeTool;
          export default defineNativeTool({ description: "bad", inputSchema: {} });
        `,
        { checksNativeOwnership: true },
      ),
      ["ordinary-resource"],
    );
  });

  it("finds direct literal lifecycle equality and switch branches", () => {
    for (const fixture of [
      `if (toolName === "task_update") run();`,
      `switch (kernelCapability) { case "final_output": run(); }`,
    ]) {
      assert.deepEqual(analyzeRule43Fixture(fixture, { checksLiteralBranches: true }), [
        "literal-branch",
      ]);
    }
  });

  it("ignores comment-only inventory and primitive text", () => {
    assert.deepEqual(
      analyzeRule43Fixture(
        `
          // KERNEL_CAPABILITY_NAMES, defineTool({}), and new Set(["agent"])
          export const harmless = "ordinary text";
        `,
        { checksNativeOwnership: true },
      ),
      [],
    );
  });
});
