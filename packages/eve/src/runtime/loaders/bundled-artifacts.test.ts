import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  installBundledCompiledArtifactsFromDescriptor,
  readBundledCompiledArtifacts,
  withBundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";
import { identifyCompiledModuleMap } from "#protocol/compiled-module-map-identity.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";

type MemoryCompilation = Awaited<ReturnType<typeof compileFromMemory>>;

interface TestDescriptorLoader {
  artifactIdentity: string;
  backing: CompiledModuleBacking;
  load: () => Promise<Record<string, unknown>>;
  validate?: unknown;
}

interface TestModuleMapDescriptor {
  identity: string;
  nodes: Record<string, { modules: Record<string, TestDescriptorLoader> }>;
}

function createTestModuleMapDescriptor(
  compiled: MemoryCompilation,
  hooks: {
    readonly load?: (sourceId: string) => void;
    readonly validate?: (sourceId: string) => Promise<void> | void;
  } = {},
): { descriptor: TestModuleMapDescriptor; programmaticSourceIds: readonly string[] } {
  const identity = compiled.metadata.compile.moduleMap.identitySha256;
  const modules = Object.fromEntries(
    Object.entries(compiled.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules).map(
      ([sourceId, namespace]) => {
        const backing = compiled.manifest.bindings[sourceId]!.backing;
        const loader: TestDescriptorLoader = {
          artifactIdentity: identity,
          backing,
          load: async () => {
            hooks.load?.(sourceId);
            return namespace;
          },
        };
        if (backing.kind === "programmatic") {
          loader.validate = async () => await hooks.validate?.(sourceId);
        }
        return [sourceId, loader];
      },
    ),
  );
  return {
    descriptor: {
      identity,
      nodes: { [ROOT_COMPILED_AGENT_NODE_ID]: { modules } },
    },
    programmaticSourceIds: Object.entries(compiled.manifest.bindings)
      .filter(([, binding]) => binding.backing.kind === "programmatic")
      .map(([sourceId]) => sourceId)
      .filter((sourceId) => modules[sourceId] !== undefined),
  };
}

describe("withBundledCompiledArtifacts", () => {
  it("installs artifacts only for the scoped runtime session", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });

    await withRuntimeSession(createRuntimeSession("outer"), async () => {
      expect(readBundledCompiledArtifacts()).toBeNull();

      const inner = await withBundledCompiledArtifacts(
        {
          ...compiled,
          sessionId: "inner",
        },
        () => ({
          artifacts: readBundledCompiledArtifacts(),
          sessionId: getActiveRuntimeSession().id,
        }),
      );

      expect(inner.sessionId).toBe("inner");
      expect(inner.artifacts?.manifest).toEqual(compiled.manifest);
      expect(inner.artifacts?.diagnostics).toEqual(compiled.diagnostics);
      expect(readBundledCompiledArtifacts()).toBeNull();
    });
  });

  it("rejects missing or malformed diagnostics before installing a bundle", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });

    await expect(
      withBundledCompiledArtifacts(
        {
          manifest: compiled.manifest,
          metadata: compiled.metadata,
          moduleMap: compiled.moduleMap,
        } as Parameters<typeof withBundledCompiledArtifacts>[0],
        () => undefined,
      ),
    ).rejects.toThrow("invalid compiler diagnostics");

    await expect(
      withBundledCompiledArtifacts(
        {
          diagnostics: {
            diagnostics: [],
            kind: "eve-compiler-diagnostics",
            summary: { errors: 0, warnings: 1 },
            version: 3,
          },
          manifest: compiled.manifest,
          metadata: compiled.metadata,
          moduleMap: compiled.moduleMap,
        },
        () => undefined,
      ),
    ).rejects.toThrow("Diagnostics summary does not match entries");
    expect(readBundledCompiledArtifacts()).toBeNull();
  });

  it("rejects diagnostics that disagree with the manifest before installing a bundle", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });

    await expect(
      withBundledCompiledArtifacts(
        {
          diagnostics: compiled.diagnostics,
          manifest: {
            ...compiled.manifest,
            diagnosticsSummary: { errors: 0, warnings: 1 },
          },
          metadata: compiled.metadata,
          moduleMap: compiled.moduleMap,
        },
        () => undefined,
      ),
    ).rejects.toThrow("does not match diagnosticsSummary");
    expect(readBundledCompiledArtifacts()).toBeNull();
  });

  it("rejects malformed config provenance before installing a bundled module map", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });
    const configSource = compiled.manifest.config.source!;

    await expect(
      withBundledCompiledArtifacts(
        {
          ...compiled,
          manifest: {
            ...compiled.manifest,
            config: {
              ...compiled.manifest.config,
              source: { ...configSource, sourceId: "memory::missing-agent.ts" },
            },
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow(
      'config source "memory::missing-agent.ts" does not match selected agent source "eve-memory-application:agent.ts"',
    );
    expect(readBundledCompiledArtifacts()).toBeNull();
  });

  it.each([
    {
      expected: 'missing node "__root__"',
      mutate: () => ({ nodes: {} }),
      name: "missing node",
    },
    {
      expected: 'unexpected node "unexpected"',
      mutate: (compiled: Awaited<ReturnType<typeof compileFromMemory>>) => ({
        nodes: { ...compiled.moduleMap.nodes, unexpected: { modules: {} } },
      }),
      name: "extra node",
    },
    {
      expected: 'is missing module "eve-memory-application:tools/search.ts"',
      mutate: (compiled: Awaited<ReturnType<typeof compileFromMemory>>) => ({
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: Object.fromEntries(
              Object.entries(compiled.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules).filter(
                ([sourceId]) => sourceId !== "eve-memory-application:tools/search.ts",
              ),
            ),
          },
        },
      }),
      name: "missing module",
    },
    {
      expected: 'has unexpected module "memory::unexpected.ts"',
      mutate: (compiled: Awaited<ReturnType<typeof compileFromMemory>>) => ({
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              ...compiled.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules,
              "memory::unexpected.ts": {},
            },
          },
        },
      }),
      name: "extra module",
    },
  ])("rejects a bundled $name before installation", async ({ expected, mutate }) => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "search" }],
    });

    await expect(
      withBundledCompiledArtifacts(
        {
          ...compiled,
          moduleMap: mutate(compiled),
        },
        () => undefined,
      ),
    ).rejects.toThrow(expected);
    expect(readBundledCompiledArtifacts()).toBeNull();
  });

  it("rejects a same-key module map from another source generation", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "search" }],
    });
    const substituted = identifyCompiledModuleMap(
      { nodes: compiled.moduleMap.nodes },
      "0".repeat(64),
    );

    await expect(
      withBundledCompiledArtifacts({ ...compiled, moduleMap: substituted }, () => undefined),
    ).rejects.toThrow("compiled module map identity mismatch");
  });

  it("does not invoke a namespace loader when inert bundle preflight fails", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });
    let evaluations = 0;
    const modules = compiled.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules;

    await expect(
      installBundledCompiledArtifactsFromDescriptor({
        diagnostics: compiled.diagnostics,
        manifest: compiled.manifest,
        metadata: { ...compiled.metadata, status: "failed" },
        moduleMapDescriptor: {
          identity: compiled.metadata.compile.moduleMap.identitySha256,
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: Object.fromEntries(
                Object.entries(modules).map(([sourceId, namespace]) => [
                  sourceId,
                  {
                    artifactIdentity: compiled.metadata.compile.moduleMap.identitySha256,
                    backing: compiled.manifest.bindings[sourceId]!.backing,
                    load: async () => {
                      evaluations += 1;
                      return namespace;
                    },
                    ...(compiled.manifest.bindings[sourceId]!.backing.kind === "programmatic"
                      ? { validate: () => undefined }
                      : {}),
                  },
                ]),
              ),
            },
          },
        },
      }),
    ).rejects.toThrow('status must be "ready"');

    expect(evaluations).toBe(0);
  });

  it("settles every programmatic validator and invokes no namespace when a later one fails", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "first" }, { name: "second" }],
    });
    const loads: string[] = [];
    const validations: string[] = [];
    const completedValidations: string[] = [];
    const fixture = createTestModuleMapDescriptor(compiled, {
      load: (sourceId) => loads.push(sourceId),
      validate: async (sourceId) => {
        validations.push(sourceId);
        if (sourceId === "eve-memory-application:tools/first.ts") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          completedValidations.push(sourceId);
        }
        if (sourceId === "eve-memory-application:tools/second.ts") {
          throw new Error("later programmatic registry mismatch");
        }
      },
    });

    expect(fixture.programmaticSourceIds).toEqual(
      expect.arrayContaining([
        "eve-memory-application:tools/first.ts",
        "eve-memory-application:tools/second.ts",
      ]),
    );
    await expect(
      installBundledCompiledArtifactsFromDescriptor({
        diagnostics: compiled.diagnostics,
        manifest: compiled.manifest,
        metadata: compiled.metadata,
        moduleMapDescriptor: fixture.descriptor,
      }),
    ).rejects.toThrow("later programmatic registry mismatch");

    expect(new Set(validations)).toEqual(new Set(fixture.programmaticSourceIds));
    expect(completedValidations).toEqual(["eve-memory-application:tools/first.ts"]);
    expect(loads).toEqual([]);
  });

  it("invokes no validator or namespace when a later descriptor binding mismatches", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "first" }, { name: "second" }],
    });
    const loads: string[] = [];
    const validations: string[] = [];
    const fixture = createTestModuleMapDescriptor(compiled, {
      load: (sourceId) => loads.push(sourceId),
      validate: (sourceId) => {
        validations.push(sourceId);
      },
    });
    const second =
      fixture.descriptor.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[
        "eve-memory-application:tools/second.ts"
      ]!;
    if (second.backing.kind !== "programmatic") {
      throw new Error("Expected the second test module to be programmatic.");
    }
    second.backing = { ...second.backing, revision: "mismatched-later-revision" };

    await expect(
      installBundledCompiledArtifactsFromDescriptor({
        diagnostics: compiled.diagnostics,
        manifest: compiled.manifest,
        metadata: compiled.metadata,
        moduleMapDescriptor: fixture.descriptor,
      }),
    ).rejects.toThrow(
      'Module-map descriptor binding mismatch for "__root__:eve-memory-application:tools/second.ts"',
    );
    expect(validations).toEqual([]);
    expect(loads).toEqual([]);
  });

  it.each([
    { malformed: false, name: "missing" },
    { malformed: true, name: "malformed" },
  ])(
    "rejects a $name later programmatic validator before any namespace loads",
    async ({ malformed }) => {
      const compiled = await compileFromMemory({
        model: "openai/gpt-5-mini",
        tools: [{ name: "first" }, { name: "second" }],
      });
      const loads: string[] = [];
      const fixture = createTestModuleMapDescriptor(compiled, {
        load: (sourceId) => loads.push(sourceId),
      });
      const second =
        fixture.descriptor.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[
          "eve-memory-application:tools/second.ts"
        ]!;
      if (malformed) second.validate = "not-a-function";
      else delete second.validate;

      await expect(
        installBundledCompiledArtifactsFromDescriptor({
          diagnostics: compiled.diagnostics,
          manifest: compiled.manifest,
          metadata: compiled.metadata,
          moduleMapDescriptor: fixture.descriptor,
        }),
      ).rejects.toThrow(malformed ? "invalid module-map descriptor loader" : "registry validator");
      expect(loads).toEqual([]);
    },
  );

  it("rejects a filesystem descriptor validator before any namespace loads", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "first" }],
    });
    const loads: string[] = [];
    const fixture = createTestModuleMapDescriptor(compiled, {
      load: (sourceId) => loads.push(sourceId),
    });
    const first =
      fixture.descriptor.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[
        "eve-memory-application:tools/first.ts"
      ]!;
    first.backing = {
      externalDependencies: [],
      kind: "filesystem",
      sourcePath: "/tmp/first.ts",
    };

    await expect(
      installBundledCompiledArtifactsFromDescriptor({
        diagnostics: compiled.diagnostics,
        manifest: compiled.manifest,
        metadata: compiled.metadata,
        moduleMapDescriptor: fixture.descriptor,
      }),
    ).rejects.toThrow("cannot define a registry validator");
    expect(loads).toEqual([]);
  });
});
