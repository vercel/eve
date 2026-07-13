import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { writeCompiledArtifactsFiles } from "../../src/internal/application/compiled-artifacts.js";
import { resolvePackageSourceFilePath } from "../../src/internal/application/package.js";
import { createBundledRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompileMetadata } from "../../src/runtime/loaders/compile-metadata.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

describe("writeCompiledArtifactsFiles", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__eveInstrumentationLoaded;
  });

  it("installs compile metadata into bundled compiled artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiled-artifacts-bootstrap-", {
      packageName: "compiled-artifacts-bootstrap-test-agent",
    });
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });
    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");

    expect(bootstrapSource).toContain(
      resolvePackageSourceFilePath("src/runtime/loaders/bundled-artifacts.ts").replaceAll(
        "\\",
        "/",
      ),
    );

    await withRuntimeSession(createRuntimeSession("compiled-artifacts-bootstrap"), async () => {
      await import(pathToFileURL(generatedArtifacts.bootstrapPath).href);

      await expect(
        loadCompileMetadata({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        }),
      ).resolves.toEqual(compileResult.metadata);
    });
  });

  it("writes instrumentation into a dedicated Nitro plugin instead of inlining it", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiled-artifacts-instrumentation-", {
      packageName: "compiled-artifacts-instrumentation-test-agent",
    });
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "instrumentation.ts"),
      ['(globalThis as Record<string, unknown>).__eveInstrumentationLoaded = "yes";', ""].join(
        "\n",
      ),
    );

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });
    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");
    const instrumentationPluginPath = generatedArtifacts.instrumentationPluginPath;

    if (instrumentationPluginPath === undefined) {
      throw new Error("Expected instrumentation plugin path to be generated.");
    }

    expect(generatedArtifacts.instrumentationPluginPath).toBeDefined();
    expect(bootstrapSource).not.toContain("__eveInstrumentationLoaded");

    const instrumentationPluginSource = await readFile(instrumentationPluginPath, "utf8");

    expect(instrumentationPluginSource).toContain(
      join(agentRoot, "instrumentation.ts").replaceAll("\\", "/"),
    );
    expect(instrumentationPluginSource).toContain(
      `import * as instrumentationModule from ${JSON.stringify(join(agentRoot, "instrumentation.ts").replaceAll("\\", "/"))};`,
    );
    expect(instrumentationPluginSource).toContain("registerInstrumentationConfig");

    const instrumentationPluginModule = (await import(
      pathToFileURL(instrumentationPluginPath).href
    )) as {
      default: () => void;
    };

    expect((globalThis as Record<string, unknown>).__eveInstrumentationLoaded).toBe("yes");
    expect(instrumentationPluginModule.default()).toBeUndefined();
  });

  it("surfaces instrumentation import failures when the Nitro plugin module loads", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-instrumentation-error-",
      { packageName: "compiled-artifacts-instrumentation-error-test-agent" },
    );
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "instrumentation.ts"),
      'throw new Error("instrumentation boom");\n',
    );

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });
    const instrumentationPluginPath = generatedArtifacts.instrumentationPluginPath;

    if (instrumentationPluginPath === undefined) {
      throw new Error("Expected instrumentation plugin path to be generated.");
    }

    await expect(
      import(`${pathToFileURL(instrumentationPluginPath).href}?case=throws-on-import`),
    ).rejects.toThrow("instrumentation boom");
  });

  it("stages packaged skill files for bundled artifacts after the authored agent tree is removed", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-workspace-bootstrap-",
      { packageName: "compiled-artifacts-workspace-bootstrap-test-agent" },
    );
    const outDir = join(appRoot, ".workflow-build");

    await mkdir(join(agentRoot, "skills", "research", "references"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "skills", "research", "SKILL.md"),
      [
        "---",
        "description: Research requests.",
        "---",
        "",
        "Use the attached playbook before answering.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(agentRoot, "skills", "research", "references", "playbook.md"),
      "Always confirm the source of truth.\n",
    );

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });

    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");

    expect(bootstrapSource).not.toContain("workspaceResources");
    expect(bootstrapSource).not.toContain("contentBase64");
    expect(bootstrapSource).not.toContain("Always confirm the source of truth.");
    await expect(
      readFile(
        join(
          compileResult.paths.compileDirectoryPath,
          "workspace-resources",
          "__root__",
          "skills",
          "research",
          "references",
          "playbook.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("Always confirm the source of truth.\n");
  });
});
