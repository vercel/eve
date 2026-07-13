import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import {
  pruneDevelopmentRuntimeArtifactsSnapshots,
  resolveDevelopmentRuntimeArtifactsPointerPath,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import {
  prepareDevelopmentApplicationHost,
  prepareProductionApplicationHost,
} from "#internal/nitro/host/prepare-application-host.js";

const createAppRoot = useTemporaryAppRoots();

interface DevelopmentRuntimePointer {
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
}

async function readDevelopmentRuntimePointer(appRoot: string): Promise<DevelopmentRuntimePointer> {
  return JSON.parse(
    await readFile(resolveDevelopmentRuntimeArtifactsPointerPath(appRoot), "utf8"),
  ) as DevelopmentRuntimePointer;
}

describe("application host preparation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("keeps production compiler and host writes inside one invocation workspace", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-production-host-workspace-", {
      files: {
        "agent/instructions.md": "Use the configured model.",
      },
      packageName: "production-host-workspace",
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    const workspace = await createApplicationBuildWorkspace(appRoot);

    try {
      const preparedHost = await prepareProductionApplicationHost(workspace);

      expect(preparedHost.compileResult.paths.compileDirectoryPath).toBe(
        join(workspace.compilerArtifactsRoot, "compile"),
      );
      expect(preparedHost.compiledArtifacts.bootstrapPath).toBe(
        join(workspace.hostArtifactsDir, "compiled-artifacts-bootstrap.mjs"),
      );
      expect(preparedHost.workflowBuildDir).toBe(workspace.workflowBuildDir);
      expect(existsSync(join(appRoot, ".eve", "compile"))).toBe(false);
      expect(existsSync(join(appRoot, ".eve", "host"))).toBe(false);
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }

    expect(existsSync(workspace.rootDir)).toBe(false);
  });

  it("selects the Vercel Workflow world for a prebuilt production host", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const { agentRoot, appRoot } = await createAppRoot("eve-vercel-production-world-", {
      files: {
        "agent/instructions.md": "Use the configured model.",
      },
      packageName: "vercel-production-world",
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    const workspace = await createApplicationBuildWorkspace(appRoot);

    try {
      const preparedHost = await prepareProductionApplicationHost(workspace);
      const workflowWorldPlugin = await readFile(
        preparedHost.compiledArtifacts.workflowWorldPluginPath,
        "utf8",
      );

      expect(workflowWorldPlugin).toContain("/compiled/@workflow/world-vercel/index.js");
      expect(workflowWorldPlugin).not.toContain("/compiled/@workflow/world-local/index.js");
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }
  });

  it("keeps Nitro host inputs stable when their runtime snapshot is pruned", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-stable-dev-host-artifacts-", {
      files: {
        "agent/instructions.md": "Use the configured model.",
      },
      packageName: "stable-dev-host-artifacts",
    });
    const agentModulePath = join(agentRoot, "agent.mjs");
    await writeFile(agentModulePath, 'export default { model: "openai/gpt-5.4" };\n');

    const firstHost = await prepareDevelopmentApplicationHost(appRoot);
    const firstPointer = await readDevelopmentRuntimePointer(appRoot);
    const stableHostDirectory = join(appRoot, ".eve", "host");
    const stableBootstrapPath = join(stableHostDirectory, "compiled-artifacts-bootstrap.mjs");
    const snapshotBootstrapPath = join(
      firstPointer.runtimeAppRoot,
      ".eve",
      "compile",
      "compiled-artifacts-bootstrap.mjs",
    );

    expect(firstHost.compiledArtifacts.bootstrapPath).toBe(stableBootstrapPath);
    expect(firstHost.compiledArtifacts.workflowWorldPluginPath).toBe(
      join(stableHostDirectory, "compiled-artifacts-workflow-world.mjs"),
    );
    expect(firstHost.compiledArtifacts.bootstrapPath).not.toContain("/.eve/dev-runtime/snapshots/");
    expect(await readFile(stableBootstrapPath, "utf8")).toContain(
      normalizeEsmImportSpecifier(agentModulePath),
    );
    expect(existsSync(snapshotBootstrapPath)).toBe(false);

    await writeFile(
      agentModulePath,
      'export default { model: "openai/gpt-5.4" };\n// revision two\n',
    );
    const nextHost = await prepareDevelopmentApplicationHost(appRoot);
    const nextPointer = await readDevelopmentRuntimePointer(appRoot);

    expect(nextHost.compiledArtifacts.bootstrapPath).toBe(stableBootstrapPath);
    expect(nextPointer.snapshotRoot).not.toBe(firstPointer.snapshotRoot);

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      now: Date.now() + 1_000,
      recentWindowMs: 0,
      retainCount: 0,
    });

    expect(existsSync(firstPointer.snapshotRoot)).toBe(false);
    expect(existsSync(stableBootstrapPath)).toBe(true);
  });
});
