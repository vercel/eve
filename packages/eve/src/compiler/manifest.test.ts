import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
} from "#compiler/manifest.js";
import {
  validateCompiledAgentManifest,
  validateCompiledModuleMap,
} from "#compiler/validate-artifact.js";

describe("compiled agent manifest v42", () => {
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

  it("rejects module maps whose keys diverge from total bindings", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const root = moduleMap.nodes.__root__!;

    expect(() =>
      validateCompiledModuleMap(manifest, {
        nodes: { ...moduleMap.nodes, __root__: { modules: { ...root.modules, orphan: {} } } },
      }),
    ).toThrow("do not match its bindings");
  });
});
