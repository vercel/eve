import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { compiledOf } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { declared } from "#runtime/types.js";

const createAppRoot = useTemporaryAppRoots();

const MEDIA_TYPE = "application/vnd.acme.summary+json";

function renderer(title: string): string {
  return [
    'import { defineContentRenderer } from "eve/renderers";',
    `export default defineContentRenderer({ mediaType: "${MEDIA_TYPE}", card: () => ({ type: "card", title: "${title}", children: [] }) });`,
  ].join("\n");
}

/** An extension package `name` whose only contribution is a renderer drawing cards titled `name`. */
function extensionPackage(name: string): Record<string, string> {
  const root = `node_modules/@acme/${name}`;
  return {
    [`${root}/package.json`]: JSON.stringify({
      eve: { extension: { dist: "extension", source: "source" } },
      exports: { ".": "./extension/extension.mjs" },
      name: `@acme/${name}`,
      type: "module",
    }),
    [`${root}/extension/_manifest.json`]: JSON.stringify({
      builtWithEve: "0.0.0",
      contractMajor: 0,
      formatVersion: 3,
      kind: "eve-extension",
    }),
    [`${root}/extension/extension.mjs`]:
      'import { defineExtension } from "eve/extension"; export default defineExtension({});',
    [`${root}/extension/renderers/summary.mjs`]: renderer(name),
    [`agent/extensions/${name}.mjs`]: `export { default } from "@acme/${name}";`,
  };
}

const agentFiles = {
  "agent/agent.mjs":
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
  "agent/instructions.md": "Answer with summary cards.",
};

async function resolvedRenderers(appRoot: string) {
  await compileAgent({ startPath: appRoot });
  const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({ compiledArtifactsSource }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
  ]);
  const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
  return {
    compiled: compiledOf(manifest, "renderer"),
    resolved: declared(graph.root.agent, "renderer"),
  };
}

describe("content renderers", () => {
  it("resolves an extension's renderer, and the agent's own renderer wins over it", async () => {
    const mounted = await createAppRoot("eve-renderer-extension-", {
      files: { ...agentFiles, ...extensionPackage("cards") },
    });
    const fromExtension = await resolvedRenderers(mounted.appRoot);
    expect(fromExtension.compiled).toEqual([
      expect.objectContaining({ extensionNamespace: "cards", mediaType: MEDIA_TYPE }),
    ]);
    expect(fromExtension.resolved[0]?.renderer.card?.({}, { partial: false })).toMatchObject({
      title: "cards",
    });

    const overridden = await createAppRoot("eve-renderer-override-", {
      files: {
        ...agentFiles,
        ...extensionPackage("cards"),
        "agent/renderers/summary.mjs": renderer("agent"),
      },
    });
    const own = await resolvedRenderers(overridden.appRoot);
    expect(own.compiled.map((entry) => entry.logicalPath)).toEqual(["renderers/summary.mjs"]);
    expect(own.resolved[0]?.renderer.card?.({}, { partial: false })).toMatchObject({
      title: "agent",
    });
  });

  it("refuses two extensions that draw the same media type", async () => {
    const app = await createAppRoot("eve-renderer-conflict-", {
      files: { ...agentFiles, ...extensionPackage("cards"), ...extensionPackage("charts") },
    });

    await expect(compileAgent({ startPath: app.appRoot })).rejects.toThrow(
      `both draw "${MEDIA_TYPE}"`,
    );
  });
});
