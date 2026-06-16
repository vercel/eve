import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCompilerArtifactPaths } from "../../src/compiler/artifacts.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  loadAgentInfoData,
  resolveAgentInfoCompiledArtifactsSource,
} from "../../src/internal/nitro/routes/agent-info/load-agent-info-data.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { installBundledCompiledArtifacts } from "../../src/runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMap } from "../../src/runtime/loaders/module-map.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-data-test-agent" } as const;

describe("loadAgentInfoData", () => {
  it("prefers bundled compiled artifacts over the app-root disk path", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-agent-info-data-", APP_ROOT_OPTIONS);

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await mkdir(join(agentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.ts"),
      ["export default {};", ""].join("\n"),
    );

    await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const paths = resolveCompilerArtifactPaths(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({
        compiledArtifactsSource,
      }),
      loadCompiledModuleMap({
        compiledArtifactsSource,
      }),
    ]);

    await withRuntimeSession(createRuntimeSession("agent-info-data-test"), async () => {
      installBundledCompiledArtifacts({
        manifest,
        moduleMap,
      });

      await rm(paths.compileDirectoryPath, {
        force: true,
        recursive: true,
      });

      const agentInfoCompiledArtifactsSource = resolveAgentInfoCompiledArtifactsSource({
        appRoot,
      });
      expect(agentInfoCompiledArtifactsSource.kind).toBe("bundled");
      const data = await loadAgentInfoData({
        compiledArtifactsSource: agentInfoCompiledArtifactsSource,
      });

      expect(data.agent.config.name).toBe(data.manifest.config.name);
      expect(data.manifest.config.name).toBe(manifest.config.name);
      expect(data.agent.sandbox).not.toBeNull();
      expect(data.agent.sandbox?.sourceKind).toBe("module");
      expect(data.schedules).toEqual([]);
    });
  });
});
