import { describe, expect, it, vi } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

// Some NFS and FUSE mounts reject hard links with Linux ENOTSUPP (524), which Node cannot name.
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
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
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
          formatVersion: 1,
          builtWithEve: "0.0.0-test",
          requires: { extension: 1 },
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
});
