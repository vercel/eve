import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCompilerArtifactPaths } from "../../src/compiler/artifacts.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "../../src/compiler/manifest.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "../../src/runtime/compiled-artifacts-source.js";
import { installBundledCompiledArtifacts } from "../../src/runtime/loaders/bundled-artifacts.js";
import {
  LoadCompiledManifestError,
  loadCompiledManifest,
} from "../../src/runtime/loaders/manifest.js";
import {
  LoadCompiledModuleMapError,
  loadCompiledModuleMap,
} from "../../src/runtime/loaders/module-map.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import type { ResolvedAgent } from "../../src/runtime/types.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "../../src/internal/application/runtime-compiled-artifacts-source.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "runtime-loader-test-agent" } as const;

async function loadResolvedCompiledAgentGraph(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}) {
  const moduleMapPromise =
    input.compiledArtifactsSource.kind === "disk" &&
    input.compiledArtifactsSource.moduleMapLoaderPath !== undefined
      ? loadCompiledModuleMapFromAuthoredSource({
          compiledArtifactsSource: input.compiledArtifactsSource,
        })
      : loadCompiledModuleMap({ compiledArtifactsSource: input.compiledArtifactsSource });
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource: input.compiledArtifactsSource }),
    moduleMapPromise,
  ]);
  return await resolveRuntimeAgentGraph({ manifest, moduleMap });
}

async function loadResolvedCompiledAgent(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<ResolvedAgent> {
  return (await loadResolvedCompiledAgentGraph(input)).root.agent;
}

async function writeRuntimeLoaderFixture(agentRoot: string): Promise<void> {
  await mkdir(join(agentRoot, "channels"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "lib", "weather"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "schedules"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "skills"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "tools"), {
    recursive: true,
  });
  await writeFile(
    join(agentRoot, "channels", "slack.mjs"),
    [
      // Inline CompiledChannel shape — equivalent to what
      // `defineChannel` would produce — so the fixture does not need
      // to depend on `eve` resolving from the temp
      // package root.
      "export default {",
      '  __kind: "eve:channel",',
      '  adapter: { kind: "channel" },',
      "  routes: [",
      "    {",
      '      method: "POST",',
      '      path: "/slack",',
      '      async handler() { return new Response("ok"); },',
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(agentRoot, "agent.mjs"),
    ['export default { model: "openai/gpt-5.4" };\n'].join("\n"),
  );
  await writeFile(
    join(agentRoot, "instructions.mjs"),
    [
      'import { instructionsMarkdown } from "./lib/instructions-copy.mjs";',
      "",
      "export default { markdown: instructionsMarkdown };\n",
    ].join("\n"),
  );
  await writeFile(
    join(agentRoot, "lib", "instructions-copy.mjs"),
    'export const instructionsMarkdown = "You are a precise runtime loader test agent.";\n',
  );
  await writeFile(
    join(agentRoot, "schedules", "daily-digest.mjs"),
    'export default { cron: "0 8 * * *", markdown: "Send a weather digest." };\n',
  );
  await writeFile(
    join(agentRoot, "skills", "route-weather.mjs"),
    'export default { description: "Route weather questions.", markdown: "Route weather questions to the weather tool." };\n',
  );
  await writeFile(
    join(agentRoot, "tools", "get_weather.mjs"),
    [
      'import { createWeatherResponse } from "../lib/weather/response.mjs";',
      "",
      'export default { description: "Get the weather.", async execute(input) { return createWeatherResponse(input); } };\n',
    ].join("\n"),
  );
  await writeFile(
    join(agentRoot, "lib", "weather", "response.mjs"),
    [
      "export function createWeatherResponse(input) {",
      "  return {",
      "    city: input.city,",
      '    source: "lib",',
      "  };",
      "}\n",
    ].join("\n"),
  );
}

async function writeRuntimeLoaderSubagentFixture(agentRoot: string): Promise<void> {
  const researcherRoot = join(agentRoot, "subagents", "researcher");

  await mkdir(join(researcherRoot, "lib"), {
    recursive: true,
  });
  await mkdir(join(researcherRoot, "sandbox"), {
    recursive: true,
  });
  await mkdir(join(researcherRoot, "tools"), {
    recursive: true,
  });
  await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(
    join(agentRoot, "instructions.md"),
    "You are a precise runtime loader test agent.",
  );
  await writeFile(
    join(researcherRoot, "agent.mjs"),
    [
      "export default {",
      '  model: "openai/gpt-5.4",',
      '  description: "Research one topic in depth.",',
      "};\n",
    ].join("\n"),
  );
  await writeFile(
    join(researcherRoot, "instructions.md"),
    "Investigate research tasks thoroughly.",
  );
  await writeFile(
    join(researcherRoot, "lib", "search-response.mjs"),
    [
      "export function createSearchResponse(input) {",
      "  return {",
      "    query: input.query,",
      '    source: "subagent-lib",',
      "  };",
      "}\n",
    ].join("\n"),
  );
  await writeFile(
    join(researcherRoot, "tools", "search.mjs"),
    [
      'import { createSearchResponse } from "../lib/search-response.mjs";',
      "",
      'export default { description: "Search one topic.", async execute(input) { return createSearchResponse(input); } };\n',
    ].join("\n"),
  );
  await writeFile(
    join(researcherRoot, "sandbox", "sandbox.mjs"),
    ["export default {};\n"].join("\n"),
  );
}

async function writeRuntimeLoaderTsconfigAliasFixture(input: {
  agentRoot: string;
  appRoot: string;
}): Promise<void> {
  await mkdir(join(input.agentRoot, "lib", "weather"), {
    recursive: true,
  });
  await mkdir(join(input.agentRoot, "alias-root", "support"), {
    recursive: true,
  });
  await mkdir(join(input.agentRoot, "tools"), {
    recursive: true,
  });
  await writeFile(
    join(input.appRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/lib/*": ["agent/lib/*"],
            "@/*": ["agent/alias-root/*"],
          },
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["agent/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(input.agentRoot, "agent.ts"),
    [
      'import { runtimeModelId } from "@/lib/model.ts";',
      "",
      "export default { model: runtimeModelId };\n",
    ].join("\n"),
  );
  await writeFile(
    join(input.agentRoot, "instructions.md"),
    "You are a precise runtime loader alias test agent.\n",
  );
  await writeFile(
    join(input.agentRoot, "lib", "model.ts"),
    'export const runtimeModelId = "openai/gpt-5.4-mini";\n',
  );
  await writeFile(
    join(input.agentRoot, "lib", "weather", "response.ts"),
    [
      "export function createWeatherResponse(city: string, route: string) {",
      "  return {",
      "    city,",
      "    route,",
      '    source: "alias-lib",',
      "  };",
      "}\n",
    ].join("\n"),
  );
  await writeFile(
    join(input.agentRoot, "alias-root", "support", "route.ts"),
    'export const aliasRoute = "@/ path alias";\n',
  );
  await writeFile(
    join(input.agentRoot, "tools", "get_weather.ts"),
    [
      'import { createWeatherResponse } from "@/lib/weather/response.ts";',
      'import { aliasRoute } from "@/support/route.ts";',
      "",
      "export default {",
      '  description: "Get weather with tsconfig aliases.",',
      "  async execute(input: { city: string }) {",
      "    return createWeatherResponse(input.city, aliasRoute);",
      "  },",
      "};\n",
    ].join("\n"),
  );
}

describe("runtime compiled artifact loaders", () => {
  it("loads resolved compaction config from compiled authored artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loaders-compaction-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  compaction: {",
        '    model: "openai/gpt-5.4-mini",',
        "    thresholdPercent: 0.75,",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(agentRoot, "instructions.md"),
      "You are a precise runtime loader test agent.\n",
    );

    await compileAgent({
      startPath: appRoot,
    });

    const resolved = await loadResolvedCompiledAgent({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
    });

    expect(resolved.config).toMatchObject({
      compaction: {
        model: {
          contextWindowTokens: expect.any(Number),
          id: "openai/gpt-5.4-mini",
        },
        thresholdPercent: 0.75,
      },
      model: {
        contextWindowTokens: expect.any(Number),
        id: "openai/gpt-5.4",
      },
    });
  });

  it("loads the compiled manifest and module map from disk-backed compiler artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-runtime-loaders-", APP_ROOT_OPTIONS);
    await writeRuntimeLoaderFixture(agentRoot);

    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [manifest, moduleMap, resolvedAgent] = await Promise.all([
      loadCompiledManifest({
        compiledArtifactsSource,
      }),
      loadCompiledModuleMap({
        compiledArtifactsSource,
      }),
      loadResolvedCompiledAgent({
        compiledArtifactsSource,
      }),
    ]);
    const [compiledChannel] = manifest.channels;
    const [resolvedChannel] = resolvedAgent.channels;

    expect(manifest.config).toEqual({
      compaction: {},
      model: {
        contextWindowTokens: expect.any(Number),
        id: "openai/gpt-5.4",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "runtime-loader-test-agent",
      source: {
        sourceKind: "module",
        logicalPath: "agent.mjs",
        sourceId: "agent.mjs",
      },
    });
    expect(manifest.instructions).toEqual({
      name: "instructions",
      logicalPath: "instructions.mjs",
      markdown: "You are a precise runtime loader test agent.",
      sourceId: "instructions.mjs",
      sourceKind: "module",
    });
    if (compiledChannel === undefined) {
      throw new Error("Expected one compiled channel.");
    }
    expect(compiledChannel.kind).toBe("channel");
    if (compiledChannel.kind !== "channel") {
      throw new Error("Expected an active compiled channel entry.");
    }
    expect(compiledChannel.name).toBe("slack");
    expect(compiledChannel.method).toBe("POST");
    expect(compiledChannel.urlPath).toBe("/slack");
    expect(compiledChannel.logicalPath).toBe("channels/slack.mjs");
    expect(manifest.schedules).toEqual([
      {
        cron: "0 8 * * *",
        hasRun: false,
        name: "daily-digest",
        logicalPath: "schedules/daily-digest.mjs",
        markdown: "Send a weather digest.",
        sourceId: "schedules/daily-digest.mjs",
        sourceKind: "module",
      },
    ]);
    expect(manifest.skills).toEqual([
      {
        description: "Route weather questions.",
        logicalPath: "skills/route-weather.mjs",
        markdown: "Route weather questions to the weather tool.",
        name: "route-weather",
        sourceId: "skills/route-weather.mjs",
        sourceKind: "module",
      },
    ]);
    if (resolvedChannel === undefined) {
      throw new Error("Expected one resolved channel.");
    }
    expect(resolvedChannel.name).toBe("slack");
    expect(resolvedChannel.method).toBe("POST");
    expect(resolvedChannel.urlPath).toBe("/slack");
    expect(typeof resolvedChannel.fetch).toBe("function");
    expect(resolvedAgent.channels).toHaveLength(1);
    // Authored instructions modules execute once at build time. They never appear in
    // the runtime module map.
    expect(Object.keys(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {})).toEqual([
      "agent.mjs",
      "channels/slack.mjs",
      "tools/get_weather.mjs",
    ]);
    expect(
      (
        moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules["tools/get_weather.mjs"] as {
          default: { description: string };
        }
      ).default.description,
    ).toBe("Get the weather.");
    await expect(
      resolvedAgent.tools[0]?.execute?.(
        { city: "Brooklyn" },
        { messages: [], toolCallId: "call_1" },
      ),
    ).resolves.toEqual({
      city: "Brooklyn",
      source: "lib",
    });
    expect(resolvedAgent.instructions).toEqual(manifest.instructions);
    expect(resolvedAgent.workspaceSpec).toEqual({
      rootEntries: [],
    });
    expect(Object.keys(moduleMap.nodes)).toEqual([ROOT_COMPILED_AGENT_NODE_ID]);
  });

  it("loads bundled compiled artifacts when no app root is available", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loaders-bundled-",
      APP_ROOT_OPTIONS,
    );
    await writeRuntimeLoaderFixture(agentRoot);

    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({
        compiledArtifactsSource,
      }),
      loadCompiledModuleMap({
        compiledArtifactsSource,
      }),
    ]);

    await withRuntimeSession(createRuntimeSession("runtime-loaders-bundled-test"), async () => {
      installBundledCompiledArtifacts({
        manifest,
        moduleMap,
      });

      const bundledCompiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const [bundledManifest, bundledModuleMap, resolvedAgent] = await Promise.all([
        loadCompiledManifest({
          compiledArtifactsSource: bundledCompiledArtifactsSource,
        }),
        loadCompiledModuleMap({
          compiledArtifactsSource: bundledCompiledArtifactsSource,
        }),
        loadResolvedCompiledAgent({
          compiledArtifactsSource: bundledCompiledArtifactsSource,
        }),
      ]);

      expect(bundledManifest).toEqual(manifest);
      expect(Object.keys(bundledModuleMap.nodes)).toEqual(Object.keys(moduleMap.nodes));
      expect(
        Object.keys(bundledModuleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {}),
      ).toEqual(Object.keys(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {}));
      expect(
        (
          bundledModuleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules["tools/get_weather.mjs"] as {
            default: { description: string };
          }
        ).default.description,
      ).toBe(
        (
          moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules["tools/get_weather.mjs"] as {
            default: { description: string };
          }
        ).default.description,
      );
      expect(resolvedAgent.instructions).toEqual(manifest.instructions);
    });
  });

  it("loads local subagent tools and sandboxes without indexing lib in the module map", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loaders-subagent-lib-",
      APP_ROOT_OPTIONS,
    );

    await writeRuntimeLoaderSubagentFixture(agentRoot);
    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [graph, moduleMap] = await Promise.all([
      loadResolvedCompiledAgentGraph({
        compiledArtifactsSource,
      }),
      loadCompiledModuleMap({
        compiledArtifactsSource,
      }),
    ]);
    const researcherNode = graph.nodesByNodeId.get("subagents/researcher");

    expect(Object.keys(moduleMap.nodes)).toEqual([
      ROOT_COMPILED_AGENT_NODE_ID,
      "subagents/researcher",
    ]);
    expect(Object.keys(moduleMap.nodes["subagents/researcher"]?.modules ?? {})).toEqual([
      "agent.mjs",
      "sandbox/sandbox.mjs",
      "tools/search.mjs",
    ]);
    expect(researcherNode?.agent.instructions).toEqual({
      name: "instructions",
      logicalPath: "instructions.md",
      markdown: "Investigate research tasks thoroughly.",
      sourceId: "instructions.md",
      sourceKind: "markdown",
    });
    expect(researcherNode?.agent.sandbox).toMatchObject({
      logicalPath: "sandbox/sandbox.mjs",
      sourceId: "sandbox/sandbox.mjs",
    });
    // Authored sandboxes no longer auto-generate model tools — the tool list
    // contains only framework tools and authored tool files.
    expect(
      (researcherNode?.turnAgent.tools ?? []).some(
        (tool) =>
          (tool as { kind?: string }).kind === "authored-tool" &&
          (tool as { name?: string }).name?.endsWith("_sandbox"),
      ),
    ).toBe(false);
    await expect(
      researcherNode?.agent.tools[0]?.execute?.(
        { query: "climate" },
        { messages: [], toolCallId: "call_1" },
      ),
    ).resolves.toEqual({
      query: "climate",
      source: "subagent-lib",
    });
  });

  it("loads tool imports from tsconfig aliases for @/ and @/lib/*", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loaders-tsconfig-",
      APP_ROOT_OPTIONS,
    );

    await writeRuntimeLoaderTsconfigAliasFixture({
      agentRoot,
      appRoot,
    });
    await compileAgent({
      startPath: appRoot,
    });

    const resolvedAgent = await loadResolvedCompiledAgent({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot),
    });
    const getWeatherTool = resolvedAgent.tools.find((tool) => tool.name === "get_weather");

    if (getWeatherTool === undefined) {
      throw new Error("Expected the get_weather tool to be available.");
    }

    await expect(
      getWeatherTool.execute?.({ city: "Brooklyn" }, { messages: [], toolCallId: "call_1" }),
    ).resolves.toEqual({
      city: "Brooklyn",
      route: "@/ path alias",
      source: "alias-lib",
    });
  });

  it("reloads disk-backed tool modules after authored source changes", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loaders-reload-",
      APP_ROOT_OPTIONS,
    );
    const weatherResponsePath = join(agentRoot, "lib", "weather", "response.mjs");

    await writeRuntimeLoaderFixture(agentRoot);
    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot);
    const firstResolved = await loadResolvedCompiledAgent({
      compiledArtifactsSource,
    });
    const firstTool = firstResolved.tools[0];

    if (firstTool === undefined) {
      throw new Error("Expected one compiled tool before the source update.");
    }

    await expect(
      firstTool.execute?.({ city: "Brooklyn" }, { messages: [], toolCallId: "call_1" }),
    ).resolves.toEqual({
      city: "Brooklyn",
      source: "lib",
    });

    const weatherResponseSource = await readFile(weatherResponsePath, "utf8");
    const updatedWeatherResponseSource = weatherResponseSource.replace(
      '    source: "lib",',
      '    source: "updated-lib",',
    );
    expect(updatedWeatherResponseSource).not.toBe(weatherResponseSource);
    await writeFile(weatherResponsePath, updatedWeatherResponseSource);

    await compileAgent({
      startPath: appRoot,
    });

    const secondResolved = await loadResolvedCompiledAgent({
      compiledArtifactsSource,
    });
    const secondTool = secondResolved.tools[0];

    if (secondTool === undefined) {
      throw new Error("Expected one compiled tool after the source update.");
    }

    await expect(
      secondTool.execute?.({ city: "Brooklyn" }, { messages: [], toolCallId: "call_1" }),
    ).resolves.toEqual({
      city: "Brooklyn",
      source: "updated-lib",
    });
  });

  it("rejects invalid compiled manifests", async () => {
    const { appRoot } = await createAppRoot("eve-runtime-loader-bad-manifest-", APP_ROOT_OPTIONS);
    const manifestPath = join(appRoot, ".eve", "compile", "compiled-agent-manifest.json");

    await mkdir(join(appRoot, ".eve", "compile"), {
      recursive: true,
    });
    await writeFile(
      manifestPath,
      JSON.stringify({
        kind: "not-a-eve-manifest",
      }),
    );

    await expect(
      loadCompiledManifest({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      }),
    ).rejects.toBeInstanceOf(LoadCompiledManifestError);
  });

  it("rejects discovery manifests written to the compiled manifest path", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-runtime-loader-wrong-manifest-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    await compileAgent({
      startPath: appRoot,
    });

    const paths = resolveCompilerArtifactPaths(appRoot);
    const discoveryManifest = await readFile(paths.discoveryManifestPath, "utf8");
    await writeFile(paths.compiledManifestPath, discoveryManifest);

    await expect(
      loadCompiledManifest({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      }),
    ).rejects.toBeInstanceOf(LoadCompiledManifestError);
  });

  it("rejects invalid compiled module maps", async () => {
    const { appRoot } = await createAppRoot("eve-runtime-loader-bad-module-map-", APP_ROOT_OPTIONS);
    const moduleMapPath = join(appRoot, ".eve", "compile", "module-map.mjs");

    await mkdir(join(appRoot, ".eve", "compile"), {
      recursive: true,
    });
    await writeFile(
      moduleMapPath,
      [
        "export const moduleMap = {",
        '  nodes: { "__root__": { modules: { "agent.mjs": 42 } } },',
        "};",
        "export default moduleMap;",
        "",
      ].join("\n"),
    );

    await expect(
      loadCompiledModuleMap({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      }),
    ).rejects.toBeInstanceOf(LoadCompiledModuleMapError);
  });
});
