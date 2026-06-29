import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { BOOTSTRAP_RUNTIME_MODEL_ID } from "../../src/runtime/agent/bootstrap.js";
import { TEST_DEFAULT_MODEL_ID } from "../../src/internal/testing/app-harness.js";
import { resolveBootstrapRuntimeModel } from "../../src/runtime/agent/bootstrap-model.js";
import { createMockAuthoredRuntimeModel } from "../../src/runtime/agent/mock-model-adapter.js";
import { resolveRuntimeModelReference } from "../../src/runtime/agent/resolve-model.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "../../src/internal/application/runtime-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "../../src/runtime/sessions/compiled-agent-cache.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "runtime-model-resolution-test-agent" } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime model resolution", () => {
  it("keeps the bootstrap sentinel separate from the default authored runtime model", () => {
    expect(BOOTSTRAP_RUNTIME_MODEL_ID).not.toBe(TEST_DEFAULT_MODEL_ID);
    expect(
      resolveBootstrapRuntimeModel({
        id: TEST_DEFAULT_MODEL_ID,
      }),
    ).toBeNull();
  });

  it("forces authored runtime models onto the deterministic mock path in tests", async () => {
    vi.stubEnv("NODE_ENV", "test");

    const reference = {
      id: TEST_DEFAULT_MODEL_ID,
    } as const;

    expect(await resolveRuntimeModelReference(reference)).toBe(
      createMockAuthoredRuntimeModel(reference),
    );
  });

  it("resolves authored runtime models through the real provider path outside tests", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const reference = {
      id: TEST_DEFAULT_MODEL_ID,
    } as const;

    expect(await resolveRuntimeModelReference(reference)).not.toBe(
      createMockAuthoredRuntimeModel(reference),
    );
  });

  it("rehydrates a source-backed model whose module uses a NodeNext TypeScript import", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-model-resolution-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "lib"), { recursive: true });
    await writeFile(join(agentRoot, "lib", "model.ts"), createModelModuleSource("root"));
    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        'import { weatherModel } from "./lib/model.js";',
        "",
        "export default {",
        "  model: weatherModel,",
        "  modelOptions: {",
        // contextWindowTokens removed — catalog supplies it at compile time
        "    providerOptions: {",
        "      testProvider: {",
        '        reasoning: "enabled",',
        "      },",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise weather assistant.\n");

    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot);
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource,
    });

    expect(bundle.turnAgent.model).toMatchObject({
      contextWindowTokens: expect.any(Number),
      id: "openai/gpt-4o-mini",
      providerOptions: {
        testProvider: {
          reasoning: "enabled",
        },
      },
      source: {
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    });

    const resolvedModel = await resolveRuntimeModelReference(bundle.turnAgent.model, {
      moduleMap: bundle.moduleMap,
      nodeId: bundle.nodeId,
    });

    expect(typeof resolvedModel).not.toBe("string");

    if (typeof resolvedModel === "string") {
      throw new Error("Expected a source-backed AI SDK model instance.");
    }

    expect(resolvedModel).toMatchObject({
      modelId: "gpt-4o-mini",
      provider: "openai",
      specificationVersion: "v3",
      testMarker: "root",
    });
  });

  it("resolves a child model from the active child module-map scope", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-child-model-resolution-",
      APP_ROOT_OPTIONS,
    );
    const childRoot = join(agentRoot, "subagents", "researcher");

    await mkdir(join(agentRoot, "lib"), { recursive: true });
    await mkdir(join(childRoot, "lib"), { recursive: true });
    await writeFile(join(agentRoot, "lib", "model.ts"), createModelModuleSource("root"));
    await writeFile(join(childRoot, "lib", "model.ts"), createModelModuleSource("child"));
    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        'import { weatherModel } from "./lib/model.js";',
        "",
        "export default { model: weatherModel };",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are the root agent.\n");
    await writeFile(
      join(childRoot, "agent.ts"),
      [
        'import { weatherModel } from "./lib/model.js";',
        "",
        "export default {",
        '  description: "Research one topic.",',
        "  model: weatherModel,",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(childRoot, "instructions.md"), "You are the research agent.\n");

    await compileAgent({ startPath: appRoot });

    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot);
    const childBundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource,
      nodeId: "subagents/researcher",
    });
    const resolvedModel = await resolveRuntimeModelReference(childBundle.turnAgent.model, {
      moduleMap: childBundle.moduleMap,
      nodeId: childBundle.nodeId,
    });

    expect(resolvedModel).toMatchObject({
      modelId: "gpt-4o-mini",
      provider: "openai",
      specificationVersion: "v3",
      testMarker: "child",
    });
  });
});

function createModelModuleSource(testMarker: string): string {
  return [
    "export const weatherModel = {",
    '  specificationVersion: "v3",',
    '  provider: "openai",',
    '  modelId: "gpt-4o-mini",',
    `  testMarker: ${JSON.stringify(testMarker)},`,
    "  supportedUrls: {},",
    "  async doGenerate() {",
    '    throw new Error("not implemented");',
    "  },",
    "  async doStream() {",
    '    throw new Error("not implemented");',
    "  },",
    "};",
    "",
  ].join("\n");
}
