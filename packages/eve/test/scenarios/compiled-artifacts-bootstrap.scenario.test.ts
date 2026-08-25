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
    delete (globalThis as Record<string, unknown>).__eveProviderSetups;
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("eve.harness-instrumentation-providers")
    ];
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
      generatedArtifacts.bootstrapPath.replaceAll("\\", "/"),
    );
    expect(instrumentationPluginSource).toContain(
      `moduleMap.nodes["__root__"].modules["instrumentation.ts"]`,
    );
    expect(instrumentationPluginSource).not.toContain(
      join(agentRoot, "instrumentation.ts").replaceAll("\\", "/"),
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

  it("registers one provider per file when the instrumentationProviders flag is on", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiled-artifacts-providers-", {
      packageName: "compiled-artifacts-providers-test-agent",
    });
    const outDir = join(appRoot, ".workflow-build");
    const definePath = resolvePackageSourceFilePath(
      "src/public/instrumentation/index.ts",
    ).replaceAll("\\", "/");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: { instrumentationProviders: true },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await mkdir(join(agentRoot, "instrumentation"), { recursive: true });
    for (const slot of ["local", "otel"]) {
      await writeFile(
        join(agentRoot, "instrumentation", `${slot}.ts`),
        [
          `import { defineInstrumentation } from ${JSON.stringify(definePath)};`,
          "",
          "const container = globalThis as Record<string, unknown>;",
          "",
          "export default defineInstrumentation({",
          "  setup(context) {",
          "    container.__eveProviderSetups ??= [];",
          `    (container.__eveProviderSetups as string[]).push(\`${slot}:\${context.agentName}\`);`,
          "  },",
          "});",
          "",
        ].join("\n"),
      );
    }

    const compileResult = await compileAgent({ startPath: appRoot });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });
    const instrumentationPluginPath = generatedArtifacts.instrumentationPluginPath;

    if (instrumentationPluginPath === undefined) {
      throw new Error("Expected instrumentation plugin path to be generated.");
    }

    expect(generatedArtifacts.instrumentationSourcePaths).toEqual([
      join(agentRoot, "instrumentation", "local.ts"),
      join(agentRoot, "instrumentation", "otel.ts"),
    ]);

    const instrumentationPluginSource = await readFile(instrumentationPluginPath, "utf8");

    expect(instrumentationPluginSource).toContain('slot: "local"');
    expect(instrumentationPluginSource).toContain('slot: "otel"');
    expect(instrumentationPluginSource).toContain("seedInstrumentationProviders();");
    expect(instrumentationPluginSource).toContain("shutdownInstrumentationProviders");
    expect(instrumentationPluginSource).toContain("hooks?.hook('close'");
    expect(instrumentationPluginSource).not.toContain("registerInstrumentationConfig");

    const instrumentationPlugin = (await import(pathToFileURL(instrumentationPluginPath).href)) as {
      default: (nitroApp: {
        hooks: { hook(name: "close", handler: () => Promise<void>): void };
      }) => void;
    };
    const closeHandlers: Array<() => Promise<void>> = [];
    instrumentationPlugin.default({
      hooks: {
        hook: (_name, handler) => closeHandlers.push(handler),
      },
    });

    // The plugin resolves the registry by absolute path while the assertion
    // resolves it by package alias, so this also proves the globalThis rooting
    // survives two module instances.
    const { getInstrumentationProviders } = await import("../../src/instrumentation/providers.js");

    expect((globalThis as Record<string, unknown>).__eveProviderSetups).toEqual([
      "local:compiled-artifacts-providers-test-agent",
      "otel:compiled-artifacts-providers-test-agent",
    ]);
    expect(getInstrumentationProviders().map((entry) => entry.slot)).toEqual(["local", "otel"]);
    expect(closeHandlers).toHaveLength(1);
    await closeHandlers[0]?.();
  });

  it("generates the provider plugin for built-in destinations without authored files", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-default-providers-",
      {
        packageName: "compiled-artifacts-default-providers-test-agent",
      },
    );
    const outDir = join(appRoot, ".workflow-build");
    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: { instrumentationProviders: true },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({ startPath: appRoot });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir,
    });
    const instrumentationPluginPath = generatedArtifacts.instrumentationPluginPath;
    if (instrumentationPluginPath === undefined) {
      throw new Error("Expected instrumentation plugin path to be generated.");
    }

    expect(generatedArtifacts.instrumentationSourcePaths).toEqual([]);
    expect(await readFile(instrumentationPluginPath, "utf8")).toContain(
      "seedInstrumentationProviders();",
    );
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

    expect(compileResult.manifest.skills).toContainEqual(
      expect.objectContaining({ name: "research", sourceKind: "skill-package" }),
    );
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
