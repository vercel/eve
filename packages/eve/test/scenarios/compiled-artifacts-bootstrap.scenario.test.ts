import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  type GeneratedCompiledArtifactsFiles,
  writeCompiledArtifactsFiles,
} from "../../src/internal/application/compiled-artifacts.js";
import {
  resolveExpectedWorkflowVersion,
  resolvePackageSourceFilePath,
} from "../../src/internal/application/package.js";
import { createBundledRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompileMetadata } from "../../src/runtime/loaders/compile-metadata.js";
import { loadCompiledArtifactSet } from "../../src/runtime/loaders/compiled-artifact-set.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompilerDiagnosticsArtifact } from "../../src/runtime/loaders/compiler-diagnostics.js";
import { createCompilerDiagnosticsArtifact } from "../../src/protocol/compiler-diagnostics-artifact.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

function requireInstrumentationPluginPath(
  generatedArtifacts: GeneratedCompiledArtifactsFiles,
): string {
  const instrumentationPluginPath = generatedArtifacts.instrumentationPluginPath;
  if (instrumentationPluginPath === undefined) {
    throw new Error("Expected instrumentation plugin.");
  }
  return instrumentationPluginPath;
}

describe("writeCompiledArtifactsFiles", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__eveInstrumentationLoaded;
    delete (globalThis as Record<string, unknown>).__eveProviderSetups;
    delete (globalThis as Record<string, unknown>).__eveCustomWorldLoaded;
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("eve.harness-instrumentation-providers")
    ];
  });

  it("validates compiled artifacts before evaluating a custom Workflow world", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-custom-world-bootstrap-", {
      packageName: "custom-world-agent",
    });
    const outDir = join(appRoot, ".workflow-build");
    const worldRoot = join(appRoot, "node_modules", "@acme", "eve-world");
    const workflowCoreRoot = join(appRoot, "node_modules", "@workflow", "core");
    await mkdir(worldRoot, { recursive: true });
    await mkdir(workflowCoreRoot, { recursive: true });
    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  experimental: { workflow: { world: "@acme/eve-world" } },',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(worldRoot, "package.json"),
      `${JSON.stringify({
        exports: "./index.js",
        name: "@acme/eve-world",
        peerDependencies: {
          "@workflow/core": resolveExpectedWorkflowVersion() ?? "5.0.0-beta.43",
        },
        type: "module",
        version: "1.0.0",
      })}\n`,
    );
    await writeFile(
      join(worldRoot, "index.js"),
      [
        "globalThis.__eveCustomWorldLoaded = true;",
        "export default function createWorld() {",
        "  throw new Error('custom World should not be constructed');",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(workflowCoreRoot, "package.json"),
      `${JSON.stringify({
        exports: "./index.js",
        name: "@workflow/core",
        type: "module",
        version: resolveExpectedWorkflowVersion() ?? "5.0.0-beta.43",
      })}\n`,
    );
    await writeFile(join(workflowCoreRoot, "index.js"), "export const protocol = true;\n");

    const compileResult = await compileAgent({ startPath: appRoot });
    if (compileResult.manifest.workflowWorld.kind !== "host-module") {
      throw new Error("Expected a host-module Workflow world plan.");
    }
    expect(compileResult.manifest.workflowWorld.backing.mode).toBe("materialized");
    expect(compileResult.manifest.workflowWorld.backing.entryPath).toContain(
      join(compileResult.paths.compileDirectoryPath, "workflow-world"),
    );
    expect(compileResult.manifest.workflowWorld.backing.packages[0]?.sourceRootPath).toBe(
      await realpath(worldRoot),
    );
    const generatedArtifacts = await writeCompiledArtifactsFiles({ compileResult, outDir });
    expect(generatedArtifacts).not.toHaveProperty("workflowWorldPlan");
    expect((globalThis as Record<string, unknown>).__eveCustomWorldLoaded).toBeUndefined();

    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");
    const tamperedBootstrapSource = bootstrapSource.replace(
      '"name": "custom-world-agent"',
      '"name": "tampered-world-agent"',
    );
    expect(tamperedBootstrapSource).not.toBe(bootstrapSource);
    await writeFile(generatedArtifacts.bootstrapPath, tamperedBootstrapSource);

    await expect(
      import(`${pathToFileURL(generatedArtifacts.workflowWorldPluginPath).href}?tampered-artifact`),
    ).rejects.toThrow(/manifest|artifact|hash|identity/i);
    expect((globalThis as Record<string, unknown>).__eveCustomWorldLoaded).toBeUndefined();
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
      outDir,
    });
    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");

    expect(bootstrapSource).toContain(
      resolvePackageSourceFilePath("src/runtime/loaders/bundled-artifacts.ts").replaceAll(
        "\\",
        "/",
      ),
    );
    expect(bootstrapSource).toContain('const diagnostics = {\n  "diagnostics": []');
    expect(bootstrapSource).toContain('"kind": "eve-compiler-diagnostics"');
    expect(bootstrapSource).toContain("    diagnostics,\n    manifest,");

    await withRuntimeSession(createRuntimeSession("compiled-artifacts-bootstrap"), async () => {
      await import(pathToFileURL(generatedArtifacts.bootstrapPath).href);

      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const manifest = await loadCompiledManifest({ compiledArtifactsSource });

      await expect(
        loadCompileMetadata({
          compiledArtifactsSource,
        }),
      ).resolves.toEqual(compileResult.metadata);
      await expect(
        loadCompilerDiagnosticsArtifact({ compiledArtifactsSource, manifest }),
      ).resolves.toEqual(createCompilerDiagnosticsArtifact(compileResult.diagnostics));
      await expect(loadCompiledArtifactSet({ compiledArtifactsSource })).resolves.toMatchObject({
        manifest,
        metadata: compileResult.metadata,
      });
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
      outDir,
    });
    const bootstrapSource = await readFile(generatedArtifacts.bootstrapPath, "utf8");
    const instrumentationPluginPath = requireInstrumentationPluginPath(generatedArtifacts);

    expect(bootstrapSource).not.toContain("__eveInstrumentationLoaded");

    const instrumentationPluginSource = await readFile(instrumentationPluginPath, "utf8");

    expect(instrumentationPluginSource).not.toContain(
      join(agentRoot, "instrumentation.ts").replaceAll("\\", "/"),
    );
    expect(instrumentationPluginSource).toContain("readBundledCompiledArtifacts");
    expect(instrumentationPluginSource).toContain("installCompiledInstrumentationPlan");

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
      outDir,
    });
    const instrumentationPluginPath = requireInstrumentationPluginPath(generatedArtifacts);

    const instrumentationPluginSource = await readFile(instrumentationPluginPath, "utf8");

    expect(compileResult.manifest.instrumentation).toMatchObject({
      entries: [
        { activation: "production", slot: "agent-runs" },
        { activation: "always", slot: "local" },
        { activation: "always", slot: "otel" },
      ],
      kind: "providers",
    });
    expect(instrumentationPluginSource).toContain("installCompiledInstrumentationPlan");
    expect(instrumentationPluginSource).toContain("hooks?.hook('close'");

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
    const { getInstrumentationProviders } =
      await import("../../src/harness/instrumentation/providers.js");

    expect((globalThis as Record<string, unknown>).__eveProviderSetups).toEqual([
      "local:compiled-artifacts-providers-test-agent",
      "otel:compiled-artifacts-providers-test-agent",
    ]);
    expect(getInstrumentationProviders().map((entry) => entry.slot)).toEqual([
      "agent-runs",
      "local",
      "otel",
    ]);
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
      outDir,
    });
    const instrumentationPluginPath = requireInstrumentationPluginPath(generatedArtifacts);
    expect(compileResult.manifest.instrumentation).toMatchObject({
      entries: [
        { activation: "production", slot: "agent-runs" },
        { activation: "development", slot: "local" },
      ],
      kind: "providers",
    });
    expect(await readFile(instrumentationPluginPath, "utf8")).toContain(
      "installCompiledInstrumentationPlan",
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
      outDir,
    });
    const instrumentationPluginPath = requireInstrumentationPluginPath(generatedArtifacts);

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
