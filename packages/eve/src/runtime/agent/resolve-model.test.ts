import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module-map loader is mocked so we can assert *which* loader source-backed
// model resolution uses without standing up a compiled app on disk.
const { loadRuntimeCompiledModuleMap, loadCompiledModuleMap } = vi.hoisted(() => ({
  loadCompiledModuleMap: vi.fn(),
  loadRuntimeCompiledModuleMap: vi.fn(),
}));

vi.mock("#runtime/loaders/module-map.js", () => ({
  loadCompiledModuleMap,
  loadRuntimeCompiledModuleMap,
}));

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";

describe("resolveRuntimeModelReference", () => {
  beforeEach(() => {
    // The deterministic authored-model mock activates under NODE_ENV=test and
    // would short-circuit before the source-backed path; bypass it here.
    vi.stubEnv("NODE_ENV", "production");
    loadRuntimeCompiledModuleMap.mockReset();
    loadCompiledModuleMap.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a source-backed model through the authored-source-aware module-map loader", async () => {
    // Regression (vercel/eve#92): a code-defined model imported into the agent
    // config from a sibling module is a source-backed reference, re-imported at
    // turn time. That re-import must go through loadRuntimeCompiledModuleMap —
    // which uses the authored-source loader in dev and so resolves NodeNext
    // `.js` specifiers between authored source files — not loadCompiledModuleMap,
    // which imports the compiled module-map directly and fails to resolve them
    // in the dev runtime.
    const model = {
      doGenerate() {
        throw new Error("model should not be invoked");
      },
      doStream() {
        throw new Error("model should not be invoked");
      },
      modelId: "claude-opus-4-8",
      provider: "anthropic",
      specificationVersion: "v2",
    };

    loadRuntimeCompiledModuleMap.mockResolvedValue({
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            "agent.ts": { default: { model } },
          },
        },
      },
    });

    const reference = {
      id: "anthropic/claude-opus-4.8",
      source: {
        exportName: "default",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
    } as unknown as RuntimeModelReference;

    const compiledArtifactsSource = {
      appRoot: "/app",
      kind: "disk",
      moduleMapLoaderPath: "/eve/authored-module-map-loader.js",
    } as unknown as RuntimeCompiledArtifactsSource;

    const resolved = await resolveRuntimeModelReference(reference, { compiledArtifactsSource });

    expect(loadRuntimeCompiledModuleMap).toHaveBeenCalledWith(compiledArtifactsSource);
    expect(loadCompiledModuleMap).not.toHaveBeenCalled();
    expect(resolved).toBe(model);
  });
});
