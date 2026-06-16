import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { BOOTSTRAP_RUNTIME_MODEL_ID } from "../../src/runtime/agent/bootstrap.js";
import { TEST_DEFAULT_MODEL_ID } from "../../src/internal/testing/app-harness.js";
import { resolveBootstrapRuntimeModel } from "../../src/runtime/agent/bootstrap-model.js";
import { createMockAuthoredRuntimeModel } from "../../src/runtime/agent/mock-model-adapter.js";
import { resolveRuntimeModelReference } from "../../src/runtime/agent/resolve-model.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
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

  it("rehydrates source-backed AI SDK model instances from the compiled agent config", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-model-resolution-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.mjs"),
      [
        "const weatherModel = {",
        '  specificationVersion: "v3",',
        '  provider: "openai",',
        '  modelId: "gpt-4o-mini",',
        "  supportedUrls: {},",
        "  async doGenerate() {",
        '    throw new Error("not implemented");',
        "  },",
        "  async doStream() {",
        '    throw new Error("not implemented");',
        "  },",
        "};",
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

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
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
        logicalPath: "agent.mjs",
        sourceId: "agent.mjs",
      },
    });

    const resolvedModel = await resolveRuntimeModelReference(bundle.turnAgent.model, {
      compiledArtifactsSource,
    });

    expect(typeof resolvedModel).not.toBe("string");

    if (typeof resolvedModel === "string") {
      throw new Error("Expected a source-backed AI SDK model instance.");
    }

    expect(resolvedModel).toMatchObject({
      modelId: "gpt-4o-mini",
      provider: "openai",
      specificationVersion: "v3",
    });
  });
});
