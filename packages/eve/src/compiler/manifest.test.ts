import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  createCompiledAgentNodeManifest,
} from "#compiler/manifest.js";
import {
  validateCompiledAgentManifest,
  validateCompiledModuleMap,
} from "#compiler/validate-artifact.js";

describe("compiled agent manifest v44", () => {
  it("round-trips a real compiled graph through the serialized schema", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });

    const parsed = compiledAgentManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(() => validateCompiledAgentManifest(parsed)).not.toThrow();
  });

  it("rejects a missing required binding", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });
    const weather = manifest.tools.find((tool) => tool.name === "weather")!;
    const bindings = { ...manifest.bindings };
    delete bindings[weather.sourceId];

    expect(() => validateCompiledAgentManifest({ ...manifest, bindings })).toThrow(
      "has no compiled binding",
    );
  });

  it("requires strict lifecycle usage on every serialized binding", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const serialized = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    const sourceId = serialized.config.source.sourceId;
    const binding = serialized.bindings[sourceId]!;

    const { usage: _usage, ...withoutUsage } = binding;
    serialized.bindings[sourceId] = withoutUsage as typeof binding;
    expect(compiledAgentManifestSchema.safeParse(serialized).success).toBe(false);

    serialized.bindings[sourceId] = {
      ...manifest.bindings[sourceId]!,
      usage: { compile: false, runtimeEntry: false },
    };
    expect(() => validateCompiledAgentManifest(serialized)).toThrow(
      `compiled binding "${sourceId}" has no compile or runtime usage`,
    );
  });

  it("rejects unreferenced bindings and invalid route provenance", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const configBinding = manifest.bindings[manifest.config.source.sourceId]!;

    expect(() =>
      validateCompiledAgentManifest({
        ...manifest,
        bindings: { ...manifest.bindings, orphan: configBinding },
      }),
    ).toThrow("is not referenced");

    expect(() =>
      validateCompiledAgentManifest({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          shadowed: [
            {
              method: "GET",
              source: {
                backing: { kind: "resource", sourcePath: "/virtual/channels/loser.ts" },
                form: "direct",
                layer: "application",
                logicalPath: "channels/loser.ts",
                owner: { kind: "application" },
                sourceId: "loser",
              },
              urlPath: "/loser",
              winnerSourceId: "missing",
            },
          ],
        },
      }),
    ).toThrow("dangling winner");
  });

  it("rejects module maps whose keys diverge from runtime entries", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const root = moduleMap.nodes.__root__!;

    expect(() =>
      validateCompiledModuleMap(manifest, {
        nodes: { ...moduleMap.nodes, __root__: { modules: { ...root.modules, orphan: {} } } },
      }),
    ).toThrow("do not match its bindings");
  });

  it("rejects a disconnected subagent parent cycle", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const agent = createCompiledAgentNodeManifest(manifest);
    const parent = {
      agent,
      backing: { kind: "resource" as const, sourcePath: "/virtual/subagents/parent" },
      description: "Parent agent.",
      entryPath: "/virtual/subagents/parent",
      logicalPath: "subagents/parent",
      name: "parent",
      nodeId: "parent-node",
      owner: { kind: "application" as const },
      parentNodeId: "child-node",
      rootPath: "/virtual/subagents/parent",
      sourceId: "parent-source",
      sourceKind: "module" as const,
    };
    const child = {
      ...parent,
      description: "Child agent.",
      entryPath: "/virtual/subagents/parent/subagents/child",
      logicalPath: "subagents/child",
      name: "child",
      nodeId: "child-node",
      parentNodeId: parent.nodeId,
      rootPath: "/virtual/subagents/parent/subagents/child",
      sourceId: "child-source",
    };
    const corrupted = compiledAgentManifestSchema.parse({
      ...manifest,
      subagents: [parent, child],
    });

    expect(() => validateCompiledAgentManifest(corrupted)).toThrow(
      "subagent graph contains a cycle",
    );
  });

  it("rejects the removed persistent-session field in compiled manifests", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        config: {
          ...manifest.config,
          experimental: { subagentPersistentSessions: true },
        },
      }),
    ).toThrow();
  });

  it("rejects the removed tasks field in compiled manifests", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const removedExperimentalConfig = { tasks: true } as unknown;

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        config: {
          ...manifest.config,
          experimental: removedExperimentalConfig,
        },
      }),
    ).toThrow();
  });
});
