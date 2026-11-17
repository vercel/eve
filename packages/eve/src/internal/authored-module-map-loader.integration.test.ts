import { describe, expect, it, vi } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION } from "#compiler/extension-compatibility.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  link: async () => {
    throw Object.assign(new Error("Unknown system error -524"), { errno: -524, syscall: "link" });
  },
}));

const createAppRoot = useTemporaryAppRoots();

describe("loadCompiledModuleMapFromAuthoredSource", () => {
  it("loads mounted extensions on a filesystem without hard links", async () => {
    const app = await createAppRoot("eve-no-hard-links-", {
      files: {
        "agent/agent.mjs":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Work with the available tools.",
        "agent/extensions/one.mjs": 'import ext from "@acme/crm"; export default ext;',
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        }),
        "node_modules/@acme/crm/extension/_manifest.json": JSON.stringify({
          kind: "eve-extension",
          formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
          builtWithEve: "0.0.0",
          contractMajor: 0,
        }),
        "node_modules/@acme/crm/extension/extension.mjs": 'export default { name: "crm" };',
      },
    });
    await compileAgent({ startPath: app.appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const manifest = await loadCompiledManifest({ compiledArtifactsSource });

    const moduleMap = await loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource });

    const mountSourceId = manifest.extensionMounts[0]!.mountSourceId;
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[mountSourceId]!.default).toEqual({
      name: "crm",
    });
  });

  it("reuses the compile's evaluation of modules that several tools share", async () => {
    const app = await createAppRoot("eve-shared-module-graph-", {
      files: sharedModuleAppFiles("__eveCompileGraphEvaluations"),
    });
    const compiled = await compileAgent({ startPath: app.appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const evaluationsAfterCompile = sharedModuleEvaluations("__eveCompileGraphEvaluations");

    const moduleMap = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource,
      moduleGraph: compiled.moduleGraph,
    });

    expect(evaluationsAfterCompile).toBe(1);
    expect(sharedModuleEvaluations("__eveCompileGraphEvaluations")).toBe(1);
    expect(Object.keys(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules)).toEqual(
      expect.arrayContaining(["tools/one.mjs", "tools/two.mjs", "tools/three.mjs"]),
    );
  });

  it("evaluates a shared module at most once with a shared graph and no compile graph", async () => {
    const app = await createAppRoot("eve-shared-module-graph-", {
      files: sharedModuleAppFiles("__eveSharedGraphEvaluations"),
    });
    await compileAgent({ startPath: app.appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const evaluationsAfterCompile = sharedModuleEvaluations("__eveSharedGraphEvaluations");

    await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource,
      moduleGraph: "shared",
    });

    expect(
      sharedModuleEvaluations("__eveSharedGraphEvaluations") - evaluationsAfterCompile,
    ).toBeLessThanOrEqual(1);
  });

  it("evaluates a shared module once per tool without a graph", async () => {
    const app = await createAppRoot("eve-shared-module-graph-", {
      files: sharedModuleAppFiles("__evePerModuleEvaluations"),
    });
    await compileAgent({ startPath: app.appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const evaluationsAfterCompile = sharedModuleEvaluations("__evePerModuleEvaluations");

    await loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource });

    expect(sharedModuleEvaluations("__evePerModuleEvaluations") - evaluationsAfterCompile).toBe(3);
  });
});

function sharedModuleAppFiles(counter: string): Record<string, string> {
  const tool = (name: string) =>
    [
      'import { defineTool } from "eve/tools";',
      'import { lookup } from "../lib/shared.mjs";',
      `export default defineTool({ description: "${name}", inputSchema: { type: "object", properties: {} }, execute: async () => lookup("${name}") });`,
    ].join("\n");
  return {
    "agent/agent.mjs":
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
    "agent/instructions.md": "Work with the available tools.",
    "agent/lib/shared.mjs": [
      `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1;`,
      "export function lookup(name) { return name; }",
    ].join("\n"),
    "agent/tools/one.mjs": tool("one"),
    "agent/tools/two.mjs": tool("two"),
    "agent/tools/three.mjs": tool("three"),
  };
}

function sharedModuleEvaluations(counter: string): number {
  return ((globalThis as Record<string, unknown>)[counter] as number | undefined) ?? 0;
}
