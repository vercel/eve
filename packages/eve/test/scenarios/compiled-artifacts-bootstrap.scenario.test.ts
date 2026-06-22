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
import {
  useTemporaryAppRoots,
  useTemporaryDirectories,
} from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();
const createTemporaryDirectory = useTemporaryDirectories();

describe("writeCompiledArtifactsFiles", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__eveInstrumentationLoaded;
  });

  it("accepts a Workflow world package whose peer range supports eve's Workflow world dependency", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiled-artifacts-world-valid-", {
      files: createWorkflowWorldPackageFiles({
        dependencyKind: "peerDependencies",
        workflowWorldRange: ">=5.0.0-0",
      }),
      packageName: "compiled-artifacts-world-valid-test-agent",
    });
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      outDir,
    });

    await expect(readFile(generatedArtifacts.bootstrapPath, "utf8")).resolves.toContain(
      'import * as workflowWorldModule from "@acme/eve-workflow-world";',
    );
  });

  it("accepts a Workflow world package whose stable v5 peer range supports eve's Workflow world major", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-world-valid-stable-peer-",
      {
        files: createWorkflowWorldPackageFiles({
          dependencyKind: "peerDependencies",
          workflowWorldRange: "^5.0.0",
        }),
        packageName: "compiled-artifacts-world-valid-stable-peer-test-agent",
      },
    );
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      outDir,
    });

    await expect(readFile(generatedArtifacts.bootstrapPath, "utf8")).resolves.toContain(
      'import * as workflowWorldModule from "@acme/eve-workflow-world";',
    );
  });

  it("accepts a Workflow world package whose regular dependency is on eve's Workflow world major", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-world-valid-dependency-",
      {
        files: createWorkflowWorldPackageFiles({
          dependencyKind: "dependencies",
          workflowWorldRange: "5.0.0-beta.18",
        }),
        packageName: "compiled-artifacts-world-valid-dependency-test-agent",
      },
    );
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      outDir,
    });

    await expect(readFile(generatedArtifacts.bootstrapPath, "utf8")).resolves.toContain(
      'import * as workflowWorldModule from "@acme/eve-workflow-world";',
    );
  });

  it("accepts a Workflow world package hoisted to a parent workspace node_modules", async () => {
    const workspaceRoot = await createTemporaryDirectory("eve-compiled-artifacts-world-hoisted-");
    const appRoot = join(workspaceRoot, "apps", "agent-app");
    const agentRoot = join(appRoot, "agent");
    const outDir = join(appRoot, ".workflow-build");

    await mkdir(agentRoot, { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "compiled-artifacts-world-hoisted-test-agent",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );

    for (const [relativePath, contents] of Object.entries(
      createWorkflowWorldPackageFiles({
        dependencyKind: "dependencies",
        workflowWorldRange: "5.0.0-beta.18",
      }),
    )) {
      const destinationPath = join(workspaceRoot, relativePath);

      await mkdir(join(destinationPath, ".."), { recursive: true });
      await writeFile(destinationPath, contents);
    }

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult,
      outDir,
    });

    await expect(readFile(generatedArtifacts.bootstrapPath, "utf8")).resolves.toContain(
      'import * as workflowWorldModule from "@acme/eve-workflow-world";',
    );
  });

  it("rejects a Workflow world package whose regular dependency is on Workflow world v4", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiled-artifacts-world-invalid-", {
      files: createWorkflowWorldPackageFiles({
        dependencyKind: "dependencies",
        workflowWorldRange: "4.2.0",
      }),
      packageName: "compiled-artifacts-world-invalid-test-agent",
    });
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });

    await expect(
      writeCompiledArtifactsFiles({
        compileResult,
        outDir,
      }),
    ).rejects.toThrow(
      'Configured Workflow world package "@acme/eve-workflow-world" declares "@workflow/world" dependency "4.2.0", but eve supports "@workflow/world" >=5.0.0-0 <6.0.0-0',
    );
  });

  it("rejects a Workflow world package whose peer range starts on Workflow world v4", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiled-artifacts-world-invalid-peer-",
      {
        files: createWorkflowWorldPackageFiles({
          dependencyKind: "peerDependencies",
          workflowWorldRange: ">=4.0.0",
        }),
        packageName: "compiled-artifacts-world-invalid-peer-test-agent",
      },
    );
    const outDir = join(appRoot, ".workflow-build");

    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: {",
        "    workflow: {",
        '      world: "@acme/eve-workflow-world",',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    const compileResult = await compileAgent({
      startPath: appRoot,
    });

    await expect(
      writeCompiledArtifactsFiles({
        compileResult,
        outDir,
      }),
    ).rejects.toThrow(
      'Configured Workflow world package "@acme/eve-workflow-world" declares "@workflow/world" peerDependency ">=4.0.0", but eve supports "@workflow/world" >=5.0.0-0 <6.0.0-0',
    );
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

function createWorkflowWorldPackageFiles(input: {
  readonly dependencyKind: "dependencies" | "peerDependencies";
  readonly workflowWorldRange: string;
}): Record<string, string> {
  return {
    "node_modules/@acme/eve-workflow-world/index.js": [
      "export default function createWorld() {",
      "  return {",
      "    createQueueHandler() {},",
      "    events: {},",
      "  };",
      "}",
      "",
    ].join("\n"),
    "node_modules/@acme/eve-workflow-world/package.json": `${JSON.stringify(
      {
        [input.dependencyKind]: {
          "@workflow/world": input.workflowWorldRange,
        },
        exports: "./index.js",
        name: "@acme/eve-workflow-world",
        type: "module",
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  };
}
