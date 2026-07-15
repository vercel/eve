import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import {
  prepareDevelopmentApplicationHost,
  prepareProductionApplicationHost,
} from "#internal/nitro/host/prepare-application-host.js";

const createAppRoot = useTemporaryAppRoots();

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
        join(workspace.compiler.artifactsDir, "compile"),
      );
      expect(preparedHost.compiledArtifacts.bootstrapPath).toBe(
        join(workspace.host.artifactsDir, "compiled-artifacts-bootstrap.mjs"),
      );
      expect(preparedHost.workflowBuildDir).toBe(workspace.workflow.buildDir);
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

  it("keeps Nitro host inputs outside retained runtime generations", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-stable-dev-host-artifacts-", {
      files: {
        "agent/instructions.md": "Use the configured model.",
      },
      packageName: "stable-dev-host-artifacts",
    });
    const agentModulePath = join(agentRoot, "agent.mjs");
    const instrumentationModulePath = join(agentRoot, "instrumentation.mjs");
    await writeFile(agentModulePath, 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(instrumentationModulePath, "export default {};\n");

    const firstHost = await prepareDevelopmentApplicationHost(appRoot);
    const firstHostDirectory = firstHost.workspace.artifactsDir;
    const firstBootstrapPath = join(firstHostDirectory, "compiled-artifacts-bootstrap.mjs");
    const snapshotBootstrapPath = join(
      firstHost.generation.runtimeAppRoot,
      ".eve",
      "compile",
      "compiled-artifacts-bootstrap.mjs",
    );

    expect(firstHost.compileResult.paths.compileDirectoryPath).toBe(
      join(firstHost.workspace.compilerArtifactsDir, "compile"),
    );
    expect(existsSync(join(appRoot, ".eve", "compile"))).toBe(false);
    expect(firstHost.compiledArtifacts.bootstrapPath).toBe(firstBootstrapPath);
    expect(firstHost.compiledArtifacts.workflowWorldPluginPath).toBe(
      join(firstHostDirectory, "compiled-artifacts-workflow-world.mjs"),
    );
    expect(firstHost.compiledArtifacts.bootstrapPath).not.toContain("/.eve/dev-runtime/snapshots/");
    expect(firstHost.compiledArtifacts.instrumentationSourcePath).toBe(
      join(firstHostDirectory, "compiled-artifacts-instrumentation-source.mjs"),
    );
    expect(await readFile(firstBootstrapPath, "utf8")).not.toContain(
      normalizeEsmImportSpecifier(agentModulePath),
    );
    await expect(
      readFile(firstHost.compiledArtifacts.instrumentationPluginPath!, "utf8"),
    ).resolves.not.toContain(normalizeEsmImportSpecifier(instrumentationModulePath));
    expect(existsSync(snapshotBootstrapPath)).toBe(false);

    await writeFile(
      agentModulePath,
      'export default { model: "openai/gpt-5.4" };\n// revision two\n',
    );
    const nextHost = await prepareDevelopmentApplicationHost(appRoot);

    expect(nextHost.workspace.rootDir).not.toBe(firstHost.workspace.rootDir);
    expect(nextHost.generation.snapshotRoot).not.toBe(firstHost.generation.snapshotRoot);

    await rm(firstHost.generation.snapshotRoot, { force: true, recursive: true });

    expect(existsSync(firstHost.generation.snapshotRoot)).toBe(false);
    expect(existsSync(firstBootstrapPath)).toBe(true);
  });
});
