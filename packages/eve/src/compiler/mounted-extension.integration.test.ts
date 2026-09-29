import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { bundleAuthoredModuleMapForGeneration } from "#internal/authored-module-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";

const createAppRoot = useTemporaryAppRoots();

function compatibilityManifest(requires: Readonly<Record<string, number>>): string {
  return JSON.stringify({
    kind: "eve-extension",
    formatVersion: 1,
    builtWithEve: "0.0.0-test",
    requires,
  });
}

/**
 * Compiles the app and hydrates the module map from authored source, the
 * `eve eval` / `eve dev` path.
 */
async function compileRuntimeGraph(appRoot: string) {
  await compileAgent({ startPath: appRoot });
  const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
  ]);
  return { graph: await resolveRuntimeAgentGraph({ manifest, moduleMap }), manifest, moduleMap };
}

/**
 * Runs the `eve eval` / `eve dev` path: the module map is hydrated from authored
 * source, so the extension-scope plugin must bind config across separately-bundled
 * mount and tool modules. Deterministic guard for the config-binding regression.
 */
describe("mounted extension via authored-source loader", () => {
  it("binds independent config for duplicate mounts and loaded application graphs", async () => {
    const app = await createAppRoot("eve-independent-extension-config-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Work with the available tools.",
        "agent/extensions/one/extension.mjs":
          'import ext from "@acme/crm"; export default ext({ account: "one" });',
        "agent/extensions/one/tools/account.mjs": [
          'import ext from "@acme/crm";',
          'import { defineState } from "eve/context";',
          'const count = defineState("override-count", () => 0);',
          'export default { description: "Read overridden account", inputSchema: {}, execute: () => { count.update(n => n + 1); return { account: ext.config.account, count: count.get() }; } };',
        ].join("\n"),
        "agent/extensions/one/subagents/helper/agent.mjs":
          'export default { model: "openai/gpt-5.4", description: "Help with accounts" };',
        "agent/extensions/one/subagents/helper/tools/peek.mjs":
          'import ext from "@acme/crm"; export default { description: "Read account", inputSchema: {}, execute: () => ext.config.account };',
        "agent/extensions/two.mjs":
          'import ext from "@acme/crm"; export default ext({ account: "two" });',
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        }),
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          tool: 1,
          config: 1,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "const config = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };",
          "export default defineExtension({ config });",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/account.mjs": [
          'import ext from "@acme/crm";',
          'import prompt from "./prompt.md?raw";',
          'import asset from "./badge.svg";',
          "const account = ext.config.account; export default { description: account, inputSchema: {}, execute: () => ({ account, prompt, asset }) };",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/prompt.md": "Account prompt",
        "node_modules/@acme/crm/extension/tools/badge.svg": "<svg/>",
      },
    });
    const first = await compileRuntimeGraph(app.appRoot);
    expect(first.manifest.tools.find((tool) => tool.name === "two__account")?.description).toBe(
      "two",
    );
    const second = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });
    const read = (map: typeof first.moduleMap, name: string) => {
      const tool = first.manifest.tools.find((entry) => entry.name === `${name}__account`)!;
      return (
        map.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[tool.sourceId]!.default as {
          execute: () => unknown;
        }
      ).execute();
    };
    const accountResult = {
      account: "two",
      prompt: "Account prompt",
      asset: "data:image/svg+xml;base64,PHN2Zy8+",
    };
    expect(read(first.moduleMap, "two")).toEqual(accountResult);
    expect(read(second, "two")).toEqual(accountResult);
    const helper = first.manifest.subagents.find((node) => node.name === "one__helper")!;
    const peek = helper.agent.tools.find((tool) => tool.name === "peek")!;
    expect(
      (
        first.moduleMap.nodes[helper.nodeId]!.modules[peek.sourceId]!.default as {
          execute: () => string;
        }
      ).execute(),
    ).toBe("one");
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      expect(read(first.moduleMap, "one")).toEqual({ account: "one", count: 1 });
      expect(read(second, "one")).toEqual({ account: "one", count: 2 });
    });
    expect(Object.keys(serializeContext(context))).toContain("override-count");
    expect(first.manifest.bindings["ext-override:one:tools/account.mjs"]?.owner.kind).toBe(
      "application",
    );

    const moduleMapPath = join(app.appRoot, ".eve", "compile", "config-map.mjs");
    const { code } = await bundleAuthoredModuleMapForGeneration({
      appRoot: app.appRoot,
      manifest: first.manifest,
      moduleMapPath,
    });
    await writeFile(moduleMapPath, code);
    const generated = (await import(`${moduleMapPath}?test=independent-config`)) as {
      default: typeof first.moduleMap;
    };
    expect(read(generated.default, "two")).toEqual(accountResult);
  });

  it("allocates a new authored-source graph on each load", async () => {
    const app = await createAppRoot("eve-fallback-generation-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Work with the available tools.",
        "agent/extensions/one.mjs": 'import ext from "@acme/crm"; export default ext;',
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        }),
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({ extension: 1 }),
        "node_modules/@acme/crm/extension/extension.mjs": "export default { instance: {} };",
      },
    });
    await compileAgent({ startPath: app.appRoot });
    const source = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const maps = await Promise.all(
      Array.from({ length: 4 }, () =>
        loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource: source }),
      ),
    );
    const manifest = await loadCompiledManifest({ compiledArtifactsSource: source });
    const id = manifest.extensionMounts[0]!.mountSourceId;
    const instances = maps.map(
      (map) => map.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[id]!.default,
    );
    expect(new Set(instances).size).toBe(4);
    expect(
      (await readdir(join(app.appRoot, ".eve", "compile"))).filter(
        (name) => name.startsWith("authored-module-map-") && name.endsWith(".mjs"),
      ),
    ).toHaveLength(1);
  });

  it("isolates configured built-in extension mounts", async () => {
    const app = await createAppRoot("eve-built-in-mounts-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Work with the available tools.",
        "agent/extensions/one.mjs":
          'import code from "eve/extensions/code"; export default code({ worker: { model: "openai/gpt-5.4", reasoning: "high" } });',
        "agent/extensions/two.mjs":
          'import code from "eve/extensions/code"; export default code({ worker: { model: "openai/gpt-5.4", reasoning: "low" } });',
      },
    });
    const { manifest, moduleMap } = await compileRuntimeGraph(app.appRoot);
    const workers = ["one", "two"].map((name) =>
      manifest.subagents.find((subagent) => subagent.name === `${name}__worker`)!,
    );
    expect(workers[0]?.owner).toMatchObject({ mountId: "extensions/one" });
    const reasoning = workers.map((worker) => {
      if ("configResolver" in worker) throw new Error("Expected static worker config.");
      const configSourceId = worker.agent.config.source.sourceId;
      const definition = moduleMap.nodes[worker.nodeId]!.modules[configSourceId]!.default as {
        model: { events: { "session.started": () => { reasoning: string } } };
      };
      return definition.model.events["session.started"]().reasoning;
    });
    expect(reasoning).toEqual(["high", "low"]);
    const second = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });
    const secondReasoning = workers.map((worker) => {
      if ("configResolver" in worker) throw new Error("Expected static worker config.");
      const definition = second.nodes[worker.nodeId]!.modules[worker.agent.config.source.sourceId]!
        .default as {
        model: { events: { "session.started": () => { reasoning: string } } };
      };
      return definition.model.events["session.started"]().reasoning;
    });
    expect(secondReasoning).toEqual(["high", "low"]);
  });

  it("keeps module instances distinct across mounts in a generation graph", async () => {
    const app = await createAppRoot("eve-mount-instances-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Work with the available tools.",
        "agent/extensions/one.mjs": 'import ext from "@acme/crm"; export default ext;',
        "agent/extensions/two.mjs": 'import ext from "@acme/crm"; export default ext;',
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        }),
        "node_modules/@acme/crm/extension/_manifest.json": JSON.stringify({
          ...JSON.parse(compatibilityManifest({ extension: 1, tool: 1 })),
          formatVersion: 2,
          build: { externalDependencies: ["nested-dependency"] },
        }),
        "node_modules/@acme/crm/node_modules/nested-dependency/package.json": JSON.stringify({
          name: "nested-dependency",
          type: "module",
          exports: "./index.mjs",
        }),
        "node_modules/@acme/crm/node_modules/nested-dependency/index.mjs":
          "export default 'nested-value';",
        "node_modules/@acme/crm/extension/extension.mjs": 'export { default } from "./handle.mjs";',
        "node_modules/@acme/crm/extension/handle.mjs":
          "import value from 'nested-dependency'; export default { instance: { value } };",
        "node_modules/@acme/crm/extension/tools/check.mjs":
          'import ext from "@acme/crm"; export default { description: "Check instance", inputSchema: {}, execute: () => ext.instance };',
      },
    });
    const { manifest, moduleMap } = await compileRuntimeGraph(app.appRoot);
    const fallbackModules = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules;
    const fallbackMounts = manifest.extensionMounts.map(
      (mount) => (fallbackModules[mount.mountSourceId]!.default as { instance: object }).instance,
    );
    expect(fallbackMounts[0]).not.toBe(fallbackMounts[1]);
    expect(fallbackMounts[0]).toEqual({ value: "nested-value" });
    const nextGraph = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });
    const nextModules = nextGraph.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules;
    expect(
      (nextModules[manifest.extensionMounts[0]!.mountSourceId]!.default as { instance: object })
        .instance,
    ).not.toBe(fallbackMounts[0]);
    for (const [index, mount] of manifest.extensionMounts.entries()) {
      const tool = manifest.tools.find((entry) => entry.name === `${mount.namespace}__check`)!;
      expect((fallbackModules[tool.sourceId]!.default as { execute: () => object }).execute()).toBe(
        fallbackMounts[index],
      );
    }
    const moduleMapPath = join(app.appRoot, ".eve", "compile", "mount-map.mjs");
    const { code } = await bundleAuthoredModuleMapForGeneration({
      appRoot: app.appRoot,
      manifest,
      moduleMapPath,
      resolveExternalPaths: true,
    });
    await mkdir(join(app.appRoot, ".eve", "compile"), { recursive: true });
    await writeFile(moduleMapPath, code);
    const map = (await import(`${moduleMapPath}?test=mount-instances`)) as {
      default: { nodes: Record<string, { modules: Record<string, Record<string, unknown>> }> };
    };
    const modules = map.default.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules;
    const mounts = manifest.extensionMounts;
    const instances = mounts.map(
      (mount) => (modules[mount.mountSourceId]!.default as { instance: object }).instance,
    );
    expect(instances[0]).not.toBe(instances[1]);
    for (const [index, mount] of mounts.entries()) {
      const tool = manifest.tools.find((entry) => entry.name === `${mount.namespace}__check`)!;
      const definition = modules[tool.sourceId]!.default as { execute: () => object };
      expect(definition.execute()).toBe(instances[index]);
    }
  });
  it("binds mounted config so a composed tool reads it", async () => {
    const app = await createAppRoot("eve-mounted-extension-authored-source-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-authored" });',
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          tool: 1,
          config: 1,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          // Minimal pass-through Standard Schema — this scenario tests binding, not validation.
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_echo.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Echo the configured API key.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { apiKey: extension.config.apiKey };",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    const { graph } = await compileRuntimeGraph(app.appRoot);

    const tool = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-authored",
    });
  });
});

/**
 * A no-config extension (`defineExtension()`, no schema) mounted with a bare
 * re-export — no factory call. Proves config is optional end to end through the
 * dev/eval loader.
 */
describe("mounted extension without config", () => {
  it("composes and runs a no-config extension mounted via re-export", async () => {
    const app = await createAppRoot("eve-mounted-extension-no-config-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/widget.mjs": 'export { default } from "@acme/widget";\n',
        "node_modules/@acme/widget/package.json": `${JSON.stringify({
          name: "@acme/widget",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/widget/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          tool: 1,
        }),
        "node_modules/@acme/widget/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "export default defineExtension();",
          "",
        ].join("\n"),
        "node_modules/@acme/widget/extension/tools/widget_ping.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Return a fixed widget token.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { token: "widget-ok" };',
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    const { graph } = await compileRuntimeGraph(app.appRoot);

    const tool = graph.root.agent.tools.find((entry) => entry.name === "widget__widget_ping");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      token: "widget-ok",
    });
  });
});

/**
 * The directory mount form with a co-located override slot. The extension's own
 * tools compose and bind config, while a consumer override of the same name
 * shadows the extension's contribution. Runs through the dev/eval authored-source
 * loader to exercise directory discovery and override precedence deterministically.
 */
describe("mounted extension via directory form with override", () => {
  it("binds base config and lets a co-located override shadow or disable a tool", async () => {
    const app = await createAppRoot("eve-mounted-extension-directory-override-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm/extension.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-dir" });',
          "",
        ].join("\n"),
        // Co-located override: shadows the extension's own crm_status.
        "agent/extensions/crm/tools/crm_status.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Report the consumer status.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { status: "consumer-status" };',
          "  },",
          "});",
          "",
        ].join("\n"),
        // Co-located override: opts out of the extension's own crm_legacy.
        "agent/extensions/crm/tools/crm_legacy.mjs": [
          'import { disableTool } from "eve/tools";',
          "export default disableTool();",
          "",
        ].join("\n"),
        // Co-located override: opts out of the extension's dynamic crm_pulse.
        "agent/extensions/crm/tools/crm_pulse.mjs": [
          'import { disableTool } from "eve/tools";',
          "export default disableTool();",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          tool: 1,
          dynamicTool: 1,
          config: 1,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_echo.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Echo the configured API key.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { apiKey: extension.config.apiKey };",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_status.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Report the extension status.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { status: "extension-status" };',
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_legacy.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "A legacy tool the consumer opts out of.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { legacy: true };",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_pulse.mjs": [
          'import { defineDynamic, defineTool } from "eve/tools";',
          "export default defineDynamic({",
          "  events: {",
          '    "session.started": async () =>',
          "      defineTool({",
          '        description: "A dynamic tool the consumer opts out of.",',
          "        inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "        async execute() {",
          "          return { pulse: true };",
          "        },",
          "      }),",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    const { graph } = await compileRuntimeGraph(app.appRoot);

    const echo = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(echo).toBeDefined();
    await expect(echo?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-dir",
    });

    const status = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_status");
    expect(status).toBeDefined();
    await expect(status?.execute?.({}, { messages: [], toolCallId: "call_2" })).resolves.toEqual({
      status: "consumer-status",
    });

    const legacy = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_legacy");
    expect(legacy).toBeUndefined();

    const pulse = graph.root.agent.dynamicToolResolvers.find(
      (resolver) => resolver.slug === "crm__crm_pulse",
    );
    expect(pulse).toBeUndefined();
  });

  it("replaces extension local and remote subagents with remote overrides", async () => {
    const app = await createAppRoot("eve-mounted-extension-subagent-override-repro-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm/extension.mjs": [
          'import crm from "@acme/crm";',
          "export default crm({});",
          "",
        ].join("\n"),
        "agent/extensions/crm/subagents/weather.mjs": [
          'import { defineRemoteAgent } from "eve";',
          "export default defineRemoteAgent({",
          '  description: "Use the remote weather agent.",',
          '  url: "https://weather.example.com",',
          "});",
          "",
        ].join("\n"),
        "agent/extensions/crm/subagents/alerts.mjs": [
          'import { defineRemoteAgent } from "eve";',
          "export default defineRemoteAgent({",
          '  description: "Use the consumer alerts agent.",',
          '  url: "https://consumer-alerts.example.com",',
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          subagent: 6,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "export default defineExtension({});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/subagents/weather/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  description: "Use the local weather agent.",',
          "};",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/subagents/alerts.mjs": [
          'import { defineRemoteAgent } from "eve";',
          "export default defineRemoteAgent({",
          '  description: "Use the extension alerts agent.",',
          '  url: "https://extension-alerts.example.com",',
          "});",
          "",
        ].join("\n"),
      },
    });

    await compileAgent({ startPath: app.appRoot });
    const manifest = await loadCompiledManifest({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });

    expect(manifest.subagents).toHaveLength(0);
    expect(manifest.remoteAgents).toMatchObject([
      {
        name: "crm__alerts",
        owner: { kind: "application" },
        url: "https://consumer-alerts.example.com",
      },
      {
        name: "crm__weather",
        owner: { kind: "application" },
        url: "https://weather.example.com",
      },
    ]);
  });
});

describe("mounted extension subagent resources", () => {
  it("materializes extension subagent resources under a Windows-safe directory", async () => {
    const app = await createAppRoot("eve-mounted-extension-subagent-resources-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": 'export { default } from "@acme/crm";\n',
        "agent/subagents/research/agent.mjs":
          'export default { model: "openai/gpt-5.4", description: "Research." };\n',
        "agent/subagents/research/extensions/crm.mjs": 'export { default } from "@acme/crm";\n',
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest({
          extension: 1,
          subagent: 6,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "export default defineExtension();",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/subagents/reviewer/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  description: "Review CRM notes.",',
          "};",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/subagents/reviewer/tools/review.mjs": [
          'import { defineTool } from "eve/tools";',
          'export default defineTool({ description: "Review notes.", inputSchema: { type: "object" }, execute: async () => ({ ok: true }) });',
          "",
        ].join("\n"),
      },
    });

    const { paths } = await compileAgent({ startPath: app.appRoot });
    const manifest = await loadCompiledManifest({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });

    const rootReviewer = manifest.subagents.find(
      (entry) => entry.name === "crm__reviewer" && entry.parentNodeId === "__root__",
    );
    const research = manifest.subagents.find((entry) => entry.name === "research");
    const researchReviewer = manifest.subagents.find(
      (entry) => entry.parentNodeId === research?.nodeId && entry.name === "crm__reviewer",
    );
    expect(manifest.extensionMounts[0]?.mountId).toBe("extensions/crm");
    expect(research?.agent.extensionMounts[0]?.mountId).toBe("subagents/research/extensions/crm");
    expect(rootReviewer?.owner).toMatchObject({ mountId: "extensions/crm" });
    expect(researchReviewer?.owner).toMatchObject({ mountId: "subagents/research/extensions/crm" });
    expect(rootReviewer?.agent.bindings["tools/review.mjs"]?.owner).toMatchObject({
      mountId: "extensions/crm",
    });
    const subagent = rootReviewer;
    expect(subagent?.nodeId).toContain(":");
    const logicalPath = subagent?.agent.workspaceResourceRoot.logicalPath ?? "";
    const [resourcesDirectory, nodeDirectory, ...nested] = logicalPath.split("/");
    expect(resourcesDirectory).toBe("workspace-resources");
    expect(nested).toEqual([]);
    expect(nodeDirectory).toMatch(/^[^<>:"/\\|?*]+$/);
    await expect(stat(join(paths.compileDirectoryPath, logicalPath))).resolves.toMatchObject({});
  });
});
