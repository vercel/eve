import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { resolveCompiledRuntimeModelCatalogCachePath } from "../../src/compiler/model-catalog.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = {
  files: {
    "agent/instructions.md": "You are a precise assistant.\n",
  },
  packageName: "test-agent",
} as const;

function mockCatalogResponse(
  models: Array<{
    slug: string;
    providers: Array<{
      provider: string;
      providerModelId: string;
      contextWindowTokens: number;
      maxOutputTokens: number;
    }>;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      models,
      providerAliases: {},
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compiler model catalog", () => {
  it("hydrates default compaction limits when the authored config omits compaction", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-default-compaction-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      ["export default {", '  model: "example/default-compaction-model",', "};", ""].join("\n"),
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockCatalogResponse([
        {
          slug: "example/default-compaction-model",
          providers: [
            {
              provider: "example",
              providerModelId: "default-compaction-model",
              contextWindowTokens: 123_456,
              maxOutputTokens: 32_000,
            },
          ],
        },
      ]),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });
    const cache = JSON.parse(
      await readFile(resolveCompiledRuntimeModelCatalogCachePath(appRoot), "utf8"),
    );

    expect(result.manifest.config).toMatchObject({
      compaction: {},
      model: {
        contextWindowTokens: 123_456,
        id: "example/default-compaction-model",
      },
    });
    expect(cache).toMatchObject({
      kind: "eve-model-catalog-cache",
      models: [
        {
          slug: "example/default-compaction-model",
          providers: [
            {
              provider: "example",
              providerModelId: "default-compaction-model",
              contextWindowTokens: 123_456,
              maxOutputTokens: 32_000,
            },
          ],
        },
      ],
      providerAliases: {},
      version: 2,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("hydrates compiled compaction limits from AI Gateway and persists the cache", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-fetch-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "example/primary-model",',
        "  compaction: {",
        '    model: "example/summary-model",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockCatalogResponse([
        {
          slug: "example/primary-model",
          providers: [
            {
              provider: "example",
              providerModelId: "primary-model",
              contextWindowTokens: 123_456,
              maxOutputTokens: 32_000,
            },
          ],
        },
        {
          slug: "example/summary-model",
          providers: [
            {
              provider: "example",
              providerModelId: "summary-model",
              contextWindowTokens: 65_536,
              maxOutputTokens: 8_192,
            },
          ],
        },
      ]),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });
    const cache = JSON.parse(
      await readFile(resolveCompiledRuntimeModelCatalogCachePath(appRoot), "utf8"),
    );

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 123_456,
      id: "example/primary-model",
    });
    expect(result.manifest.config.compaction).toMatchObject({
      model: {
        contextWindowTokens: 65_536,
        id: "example/summary-model",
      },
    });
    expect(cache).toMatchObject({
      kind: "eve-model-catalog-cache",
      version: 2,
    });
    expect(cache.fetchedAt).toEqual(expect.any(String));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("hydrates compaction limits when model IDs end in -thinking", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-thinking-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "example/primary-model-thinking",',
        "  compaction: {",
        '    model: "example/summary-model-thinking",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockCatalogResponse([
        {
          slug: "example/primary-model",
          providers: [
            {
              provider: "example",
              providerModelId: "primary-model",
              contextWindowTokens: 123_456,
              maxOutputTokens: 32_000,
            },
          ],
        },
        {
          slug: "example/summary-model",
          providers: [
            {
              provider: "example",
              providerModelId: "summary-model",
              contextWindowTokens: 65_536,
              maxOutputTokens: 8_192,
            },
          ],
        },
      ]),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 123_456,
      id: "example/primary-model-thinking",
    });
    expect(result.manifest.config.compaction).toMatchObject({
      model: {
        contextWindowTokens: 65_536,
        id: "example/summary-model-thinking",
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses stale cached AI Gateway metadata when refresh fails", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-cache-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "example/stale-primary-model",',
        "  compaction: {",
        '    model: "example/stale-summary-model",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await mkdir(join(appRoot, ".eve", "cache"), {
      recursive: true,
    });
    await writeFile(
      resolveCompiledRuntimeModelCatalogCachePath(appRoot),
      `${JSON.stringify(
        {
          fetchedAt: "2024-01-01T00:00:00.000Z",
          kind: "eve-model-catalog-cache",
          models: [
            {
              slug: "example/stale-primary-model",
              providers: [
                {
                  provider: "example",
                  providerModelId: "stale-primary-model",
                  contextWindowTokens: 111_111,
                  maxOutputTokens: 16_384,
                },
              ],
            },
            {
              slug: "example/stale-summary-model",
              providers: [
                {
                  provider: "example",
                  providerModelId: "stale-summary-model",
                  contextWindowTokens: 22_222,
                  maxOutputTokens: 4_096,
                },
              ],
            },
          ],
          providerAliases: {},
          version: 2,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 111_111,
      id: "example/stale-primary-model",
    });
    expect(result.manifest.config.compaction).toMatchObject({
      model: {
        contextWindowTokens: 22_222,
        id: "example/stale-summary-model",
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when compaction requires unresolved model limits", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-missing-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      ["export default {", '  model: "example/missing-model",', "};", ""].join("\n"),
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockCatalogResponse([]));

    await expect(
      compileAgent({
        startPath: appRoot,
      }),
    ).rejects.toThrow(
      'Cannot compile agent compaction because the primary compaction trigger model "example/missing-model" does not have known AI Gateway context window metadata.',
    );
  });

  it("uses authored modelContextWindowTokens and skips the AI Gateway lookup", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-authored-window-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "example/unlisted-model",',
        "  modelContextWindowTokens: 128_000,",
        "};",
        "",
      ].join("\n"),
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 128_000,
      id: "example/unlisted-model",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses authored modelContextWindowTokens for source-backed models and skips the AI Gateway lookup", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-authored-window-source-model-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "const sourceModel = {",
        '  specificationVersion: "v3",',
        '  provider: "openai.responses",',
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
        "  model: sourceModel,",
        "  modelContextWindowTokens: 128_000,",
        "};",
        "",
      ].join("\n"),
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 128_000,
      id: "openai/gpt-4o-mini",
      source: {
        sourceKind: "module",
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses authored compaction modelContextWindowTokens and skips the AI Gateway lookup", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-model-catalog-authored-compaction-window-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "example/unlisted-primary-model",',
        "  modelContextWindowTokens: 128_000,",
        "  compaction: {",
        '    model: "example/unlisted-summary-model",',
        "    modelContextWindowTokens: 64_000,",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config.model).toMatchObject({
      contextWindowTokens: 128_000,
      id: "example/unlisted-primary-model",
    });
    expect(result.manifest.config.compaction).toMatchObject({
      model: {
        contextWindowTokens: 64_000,
        id: "example/unlisted-summary-model",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
