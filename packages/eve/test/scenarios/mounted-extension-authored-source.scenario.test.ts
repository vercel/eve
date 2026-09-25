import type { H3Event } from "nitro";
import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  type CompiledAgentManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../../src/compiler/manifest.js";
import type { CompiledModuleMap } from "../../src/compiler/module-map.js";
import { ContextContainer, contextStorage } from "../../src/context/container.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { createDevelopmentNitroArtifactsConfig } from "../../src/internal/nitro/host/artifacts-config.js";
import { dispatchChannelRequest } from "../../src/internal/nitro/routes/channel-dispatch.js";
import type { ResolvedAgentGraphBundle } from "../../src/runtime/graph.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { BundleKey, type CompiledBundle } from "../../src/runtime/sessions/runtime-context-keys.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const compatibilityManifest = JSON.stringify({
  kind: "eve-extension",
  formatVersion: 1,
  builtWithEve: "0.0.0-test",
  requires: { extension: 1, tool: 1, config: 1 },
});

/**
 * Runs the `eve eval` / `eve dev` path: the module map is hydrated from authored
 * source, so the extension-scope plugin must bind config across separately-bundled
 * mount and tool modules. Deterministic guard for the config-binding regression.
 */
describe("mounted extension via authored-source loader", () => {
  it("binds mounted config so a composed tool reads it", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-authored-source",
      installDependencies: true,
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
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest,
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          // Minimal pass-through Standard Schema — this scenario tests binding, not validation.
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/channels/status.mjs": [
          'import { defineChannel, GET } from "eve/channels";',
          'import extension from "../extension.mjs";',
          "export default defineChannel({",
          '  routes: [GET("/crm/status", async () => new Response(extension.config.apiKey))],',
          "});",
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

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const tool = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-authored",
    });
  });

  it("keeps each agent's config when one extension is mounted in several agents", async () => {
    const { manifest, moduleMap } = await createMultiMountApp(
      "mounted-extension-authored-source-multi-mount",
    );
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const researcherNodeId = manifest.subagents[0]?.nodeId;
    expect(researcherNodeId).toBeDefined();

    await expect(echoInSession(graph, undefined)).resolves.toEqual({ apiKey: "sk-root" });
    await expect(echoInSession(graph, researcherNodeId)).resolves.toEqual({
      apiKey: "sk-researcher",
    });
  });

  it("keeps a session on its own graph's config while another graph loads", async () => {
    const { manifest, moduleMap } = await createMultiMountApp(
      "mounted-extension-authored-source-graph-generations",
    );
    const graphA = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    // A second generation of the same app (e.g. a dev reload) with a new root key.
    const graphB = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: withRootMountConfig(moduleMap, manifest, { apiKey: "sk-root-b" }),
    });

    await expect(echoInSession(graphA, undefined)).resolves.toEqual({ apiKey: "sk-root" });
    await expect(echoInSession(graphB, undefined)).resolves.toEqual({ apiKey: "sk-root-b" });
  });

  it("gives an extension channel request the root mount's config", async () => {
    const { appRoot } = await createMultiMountApp("mounted-extension-authored-source-channel");
    const request = new Request("http://localhost/crm/status");
    Object.assign(request, { ip: "127.0.0.1" });
    const event: Pick<H3Event, "context" | "waitUntil"> & { readonly req: Request } = {
      context: { params: {} },
      req: request,
      waitUntil() {},
    };

    const response = await dispatchChannelRequest(
      event as H3Event,
      "GET /crm/status",
      createDevelopmentNitroArtifactsConfig({ configuredWorld: undefined, appRoot }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("sk-root");
  });
});

/**
 * Root and a declared subagent both mount `@acme/crm` with different keys. The
 * subagent's mount evaluates last, so a last-bound lookup returns its key.
 */
async function createMultiMountApp(name: string) {
  const app = await scenarioApp({
    name,
    installDependencies: true,
    files: {
      ...crmExtensionPackageFiles(),
      "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
      "agent/instructions.md": "You are a precise assistant.\n",
      "agent/extensions/crm.mjs": [
        'import crm from "@acme/crm";',
        'export default crm({ apiKey: "sk-root" });',
        "",
      ].join("\n"),
      "agent/subagents/researcher/agent.mjs": [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  description: "Research a focused account set.",',
        "};",
        "",
      ].join("\n"),
      "agent/subagents/researcher/instructions.md": "You research accounts.\n",
      "agent/subagents/researcher/extensions/crm.mjs": [
        'import crm from "@acme/crm";',
        'export default crm({ apiKey: "sk-researcher" });',
        "",
      ].join("\n"),
    },
  });

  await compileAgent({ startPath: app.appRoot });

  const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
  ]);
  return { appRoot: app.appRoot, manifest, moduleMap };
}

/**
 * Runs the node's `crm__crm_echo` tool the way a session does: with the node's
 * bundle in context. Per-node bundles point `graph.root` at their node; the
 * root bundle carries no node id.
 */
async function echoInSession(
  graph: ResolvedAgentGraphBundle,
  nodeId: string | undefined,
): Promise<unknown> {
  const node = nodeId === undefined ? graph.root : graph.nodesByNodeId.get(nodeId);
  const execute = node?.agent.tools.find((entry) => entry.name === "crm__crm_echo")?.execute as
    | ((input: object, options: object) => Promise<unknown>)
    | undefined;
  expect(execute).toBeDefined();
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { nodesByNodeId: graph.nodesByNodeId, root: node },
    nodeId,
  } as CompiledBundle);
  return await contextStorage.run(ctx, () => execute!({}, { messages: [], toolCallId: "call_1" }));
}

/** Copies `moduleMap` with the root `@acme/crm` mount bound to `config`. */
function withRootMountConfig(
  moduleMap: CompiledModuleMap,
  manifest: CompiledAgentManifest,
  config: Record<string, unknown>,
): CompiledModuleMap {
  const mount = manifest.extensionMounts.find((entry) => entry.namespace === "crm");
  if (mount === undefined) throw new Error("Expected a root crm mount.");
  const rootNode = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID];
  if (rootNode === undefined) throw new Error("Expected a root module map node.");
  const mountModule = rootNode.modules[mount.mountSourceId];
  return {
    ...moduleMap,
    nodes: {
      ...moduleMap.nodes,
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        ...rootNode,
        modules: {
          ...rootNode.modules,
          [mount.mountSourceId]: {
            ...mountModule,
            default: {
              ...(mountModule?.default as object),
              [Symbol.for("eve.mounted-extension-config")]: config,
            },
          },
        },
      },
    },
  };
}

function crmExtensionPackageFiles(): Record<string, string> {
  return {
    "node_modules/@acme/crm/package.json": `${JSON.stringify({
      name: "@acme/crm",
      type: "module",
      eve: { extension: { source: "source", dist: "extension" } },
      exports: { ".": "./extension/extension.mjs" },
    })}\n`,
    "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest,
    "node_modules/@acme/crm/extension/extension.mjs": [
      'import { defineExtension } from "eve/extension";',
      "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
      "export default defineExtension({ config });",
      "",
    ].join("\n"),
    "node_modules/@acme/crm/extension/channels/status.mjs": [
      'import { defineChannel, GET } from "eve/channels";',
      'import extension from "../extension.mjs";',
      "export default defineChannel({",
      '  routes: [GET("/crm/status", async () => new Response(extension.config.apiKey))],',
      "});",
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
  };
}
