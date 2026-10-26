import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
} from "../../src/internal/application/package.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

vi.mock("../../src/internal/nitro/host/vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: async () => true,
}));

const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const EVE_PACKAGE_ROOT = resolvePackageRoot();
const createScratchDirectory = useTemporaryDirectories();
const DEPLOYABLE_BUILD_OPTIONS = {
  skipSandboxPrewarm: false,
} as const;

async function readJavaScriptModulesRecursively(rootDirectory: string): Promise<string> {
  // `withFileTypes` so directories named like modules (for example the
  // traced `sql.js` package directory) are not read as files.
  const entries = await readdir(rootDirectory, {
    recursive: true,
    withFileTypes: true,
  });

  return (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")),
        )
        .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
    )
  ).join("\n");
}

async function readTracedServerPackageJson(outputDir: string): Promise<{
  dependencies: Record<string, string>;
}> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(outputDir, "server", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    return {
      dependencies: packageJson.dependencies ?? {},
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        dependencies: {},
      };
    }

    throw error;
  }
}

/**
 * Writes an isolated (pnpm-style, nothing hoisted) workspace: `apps/agent`
 * depends on the `packages/backend` source package, which installs
 * `fixture-workspace-external` in its own node_modules. The agent marks it
 * external; with `appDeclaresExternal` the app installs it too.
 */
async function writeWorkspaceExternalFixture(input: {
  readonly appDeclaresExternal: boolean;
  readonly dynamicImport?: boolean;
  /** The workspace package imports `fixture-workspace-external/extra`, which only v2 exports. */
  readonly subpathImport?: boolean;
  /** Every installation's `.` export selects by this condition first; see `writeExternalInstallation`. */
  readonly exportCondition?: ExportCondition;
}): Promise<{ readonly appRoot: string }> {
  const version = input.subpathImport === true ? "2.0.0" : "1.0.0";
  const workspaceRoot = await createScratchDirectory("eve-workspace-external-dep-build-");
  const appRoot = join(workspaceRoot, "apps", "agent");
  const packageRoot = join(workspaceRoot, "packages", "backend");

  await mkdir(join(appRoot, "agent", "tools"), { recursive: true });
  await mkdir(join(appRoot, "node_modules", "@fixture"), { recursive: true });
  await mkdir(join(packageRoot, "src"), { recursive: true });
  const appDependencies: Record<string, string> = { "@fixture/backend": "workspace:*" };
  if (input.appDeclaresExternal) {
    appDependencies["fixture-workspace-external"] = version;
    await writeExternalInstallation(
      join(appRoot, "node_modules", "fixture-workspace-external"),
      version,
      input.exportCondition,
    );
  }
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify(
      {
        dependencies: appDependencies,
        name: "workspace-external-dependency-app",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(appRoot, "agent", "agent.ts"),
    [
      "export default {",
      "  build: {",
      '    externalDependencies: ["fixture-workspace-external"],',
      "  },",
      '  model: "openai/gpt-5.4-mini",',
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(join(appRoot, "agent", "instructions.md"), "Workspace external dependency.\n");
  await writeFile(
    join(appRoot, "agent", "tools", "use_backend.ts"),
    [
      'import { value } from "@fixture/backend";',
      "",
      "export default {",
      '  description: "Use a workspace package.",',
      "  execute() {",
      "    return value;",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        dependencies: { "fixture-workspace-external": version },
        exports: "./src/index.ts",
        name: "@fixture/backend",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(packageRoot, "src", "index.ts"),
    input.dynamicImport === true
      ? 'export const value = async () => (await import("fixture-workspace-external")).value;\n'
      : input.subpathImport === true
        ? 'export { value } from "fixture-workspace-external/extra";\n'
        : 'export { value } from "fixture-workspace-external";\n',
  );
  await writeExternalInstallation(
    join(packageRoot, "node_modules", "fixture-workspace-external"),
    version,
    input.exportCondition,
  );
  await symlink(packageRoot, join(appRoot, "node_modules", "@fixture", "backend"), "dir");

  return { appRoot };
}

type ExportCondition = "node" | "node-addons";

/**
 * v1 exports only `.`; v2 also exports `./extra`. With `exportCondition`, `.`
 * selects `./<condition>.js` under that condition before `import`.
 */
async function writeExternalInstallation(
  externalRoot: string,
  version: "1.0.0" | "2.0.0" = "1.0.0",
  exportCondition?: ExportCondition,
): Promise<void> {
  await mkdir(externalRoot, { recursive: true });
  const rootExport =
    exportCondition === undefined
      ? "./index.js"
      : { [exportCondition]: `./${exportCondition}.js`, import: "./index.js" };
  await writeFile(
    join(externalRoot, "package.json"),
    `${JSON.stringify(
      {
        exports: version === "1.0.0" ? rootExport : { ".": rootExport, "./extra": "./extra.js" },
        name: "fixture-workspace-external",
        type: "module",
        version,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(externalRoot, "index.js"), 'export const value = "workspace external";\n');
  if (version === "2.0.0") {
    await writeFile(join(externalRoot, "extra.js"), 'export const value = "workspace extra";\n');
  }
  if (exportCondition !== undefined) {
    await writeFile(
      join(externalRoot, `${exportCondition}.js`),
      `export const value = "workspace external (${exportCondition})";\n`,
    );
  }
}

/**
 * Mounts `@fixture/ext`, an installed extension that declares
 * `fixture-workspace-external` and installs its own v1 copy. With
 * `exportsPackageJson`, Nitro can locate the extension's package and copies
 * that v1 copy into the output.
 */
async function writeMountedExtensionDeclaringExternal(
  appRoot: string,
  input: { readonly exportsPackageJson: boolean },
): Promise<void> {
  const appPackagePath = join(appRoot, "package.json");
  const appPackage = JSON.parse(await readFile(appPackagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  appPackage.dependencies["@fixture/ext"] = "1.0.0";
  await writeFile(appPackagePath, `${JSON.stringify(appPackage, null, 2)}\n`);
  const extensionRoot = join(appRoot, "node_modules", "@fixture", "ext");
  await mkdir(join(extensionRoot, "dist", "extension"), { recursive: true });
  await writeFile(
    join(extensionRoot, "package.json"),
    `${JSON.stringify(
      {
        dependencies: { "fixture-workspace-external": "1.0.0" },
        eve: { extension: { dist: "dist/extension", source: "extension" } },
        exports: input.exportsPackageJson
          ? { ".": "./index.js", "./package.json": "./package.json" }
          : "./index.js",
        name: "@fixture/ext",
        type: "module",
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(extensionRoot, "index.js"), 'export default { name: "fx" };\n');
  await writeFile(
    join(extensionRoot, "dist", "extension", "_manifest.json"),
    `${JSON.stringify({
      build: { externalDependencies: ["fixture-workspace-external"] },
      builtWithEve: "0.0.0",
      formatVersion: 2,
      kind: "eve-extension",
      requires: {},
    })}\n`,
  );
  await writeExternalInstallation(
    join(extensionRoot, "node_modules", "fixture-workspace-external"),
  );
  await mkdir(join(appRoot, "agent", "extensions"), { recursive: true });
  await writeFile(
    join(appRoot, "agent", "extensions", "fx.ts"),
    'export { default } from "@fixture/ext";\n',
  );
}

/**
 * Copies the build output away from the workspace, so no source installation
 * is reachable, then imports the external in Node by its bare specifier from
 * beside the chunk that imports it, exactly as the bundled module does.
 */
async function importRelocatedWorkspaceExternal(
  outputDir: string,
  specifier = "fixture-workspace-external",
): Promise<unknown> {
  const relocatedRoot = await createScratchDirectory("eve-workspace-external-relocated-");
  await cp(outputDir, relocatedRoot, { recursive: true });
  const serverDirectory = await realpath(join(relocatedRoot, "server"));
  const entries = await readdir(serverDirectory, { recursive: true, withFileTypes: true });
  const importers = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
        .filter((entry) => !join(entry.parentPath, entry.name).includes("/node_modules/"))
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name);
          // An import statement or a literal dynamic import, not a mention in the embedded manifest.
          const code = await readFile(path, "utf8");
          return code.includes(`from "${specifier}"`) || code.includes(`import("${specifier}")`)
            ? path
            : null;
        }),
    )
  ).filter((path) => path !== null);
  expect(importers).not.toHaveLength(0);
  const probePath = join(dirname(importers[0]!), "relocated-external-probe.mjs");
  await writeFile(
    probePath,
    `import { value } from ${JSON.stringify(specifier)};\nprocess.stdout.write(JSON.stringify(value));\n`,
  );
  const probe = spawnSync(process.execPath, [probePath], { cwd: relocatedRoot, encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(probe.stderr);
  }
  return JSON.parse(probe.stdout) as unknown;
}

describe("app runtime dependency tracing", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__fixtureInstrumentationDep;
    vi.unstubAllEnvs();
  });

  it("bundles authored app runtime dependencies without forcing traced node_modules copies", async () => {
    const appRoot = await createScratchDirectory("eve-app-runtime-dep-build-");

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });

    const packageJsonPath = join(appRoot, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          dependencies: {
            "fixture-runtime-dep": "1.0.0",
          },
          name: "runtime-dep-trace-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      [
        "export default {",

        '  model: "openai/gpt-5.4-mini",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Trace runtime dependencies.\n");

    const runtimeDependencyRoot = join(appRoot, "node_modules", "fixture-runtime-dep");

    await mkdir(runtimeDependencyRoot, {
      recursive: true,
    });
    await writeFile(
      join(runtimeDependencyRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          name: "fixture-runtime-dep",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(runtimeDependencyRoot, "index.js"),
      [
        'export const label = "fixture-runtime-dep";',
        "export default {",
        "  label,",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, "agent", "tools", "use_fixture_dep.ts"),
      [
        'import fixtureRuntimeDep from "fixture-runtime-dep";',
        "",
        "export default {",
        '  description: "Use the fixture runtime dependency.",',
        "  execute() {",
        "    return fixtureRuntimeDep;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const tracedServerPackageJson = await readTracedServerPackageJson(outputDir);
    const serverModuleDirectory = join(outputDir, "server");
    const serverModuleEntries = await readdir(serverModuleDirectory, {
      recursive: true,
    });
    const serverModuleSource = (
      await Promise.all(
        serverModuleEntries
          .filter((entry) => entry.endsWith(".mjs"))
          .map((entry) => readFile(join(serverModuleDirectory, entry), "utf8")),
      )
    ).join("\n");

    expect(tracedServerPackageJson.dependencies).not.toHaveProperty("fixture-runtime-dep");
    expect(tracedServerPackageJson.dependencies).not.toHaveProperty(EVE_PACKAGE_INFO.name);
    await expect(
      readFile(
        join(outputDir, "server", "node_modules", "fixture-runtime-dep", "package.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(serverModuleSource).toContain('"fixture-runtime-dep"');
    expect(serverModuleSource).not.toContain('export const label = "fixture-runtime-dep";');
  }, 30_000);

  it("provides CommonJS path globals to bundled hosted dependencies", async () => {
    const appRoot = await createScratchDirectory("eve-app-runtime-cjs-path-globals-build-");

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });

    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "fixture-cjs-path-globals-dep": "1.0.0",
          },
          name: "runtime-cjs-path-globals-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      ["export default {", '  model: "openai/gpt-5.4-mini",', "};", ""].join("\n"),
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Trace CJS path globals.\n");

    const runtimeDependencyRoot = join(appRoot, "node_modules", "fixture-cjs-path-globals-dep");

    await mkdir(runtimeDependencyRoot, {
      recursive: true,
    });
    await writeFile(
      join(runtimeDependencyRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.cjs",
          },
          main: "./index.cjs",
          name: "fixture-cjs-path-globals-dep",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(runtimeDependencyRoot, "index.cjs"),
      [
        'const path = require("node:path");',
        "",
        "module.exports = {",
        "  dirnameBasename: path.basename(__dirname),",
        "  filenameBasename: path.basename(__filename),",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, "agent", "tools", "use_fixture_dep.ts"),
      [
        'import pathGlobals from "fixture-cjs-path-globals-dep";',
        "",
        "export default {",
        '  description: "Use the fixture CJS path globals dependency.",',
        "  execute() {",
        "    return pathGlobals;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const serverModuleDirectory = join(outputDir, "server");
    const serverModuleEntries = await readdir(serverModuleDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    const bundledDependencyModule = (
      await Promise.all(
        serverModuleEntries
          .filter(
            (entry) =>
              entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")),
          )
          .map(async (entry) => {
            const modulePath = join(entry.parentPath, entry.name);
            const source = await readFile(modulePath, "utf8");

            return source.includes("dirnameBasename") ? { modulePath, source } : null;
          }),
      )
    ).find((entry) => entry !== null);

    expect(bundledDependencyModule).toBeDefined();

    if (bundledDependencyModule === undefined) {
      throw new Error("Expected hosted output to bundle the CJS path globals fixture.");
    }

    await expect(
      readFile(
        join(outputDir, "server", "node_modules", "fixture-cjs-path-globals-dep", "package.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await import(pathToFileURL(bundledDependencyModule.modulePath).href);
  }, 30_000);

  it("bundles the generated JavaScript sandbox only for the workflow factory", async () => {
    async function createWorkflowAssetsApp(
      label: string,
      tool: "sleep" | "workflow",
    ): Promise<string> {
      const appRoot = await createScratchDirectory(`eve-app-workflow-assets-${label}-build-`);

      await mkdir(join(appRoot, "agent", "subagents", "researcher"), { recursive: true });
      await mkdir(join(appRoot, "agent", "tools"), { recursive: true });

      await writeFile(
        join(appRoot, "package.json"),
        `${JSON.stringify(
          {
            name: `workflow-assets-${label}-test`,
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(appRoot, "agent", "agent.ts"),
        'export default { model: "openai/gpt-5.4-mini" };\n',
      );
      await writeFile(join(appRoot, "agent", "instructions.md"), "Trace Workflow assets.\n");
      await writeFile(
        join(appRoot, "agent", "subagents", "researcher", "agent.ts"),
        'export default { description: "Research.", model: "openai/gpt-5.4-mini" };\n',
      );
      await writeFile(
        join(appRoot, "agent", "subagents", "researcher", "instructions.md"),
        "Research the request.\n",
      );
      await writeFile(
        join(appRoot, "agent", "tools", `${tool}.ts`),
        tool === "workflow"
          ? [
              'import { workflow } from "eve/tools/workflow";',
              "",
              'export default workflow({ agents: ["researcher"], maxSubagents: 6 });',
              "",
            ].join("\n")
          : 'import { sleep } from "eve/tools/sleep";\n\nexport default sleep();\n',
      );

      return appRoot;
    }

    const sleepOutputDir = await buildApplication(
      await createWorkflowAssetsApp("sleep", "sleep"),
      DEPLOYABLE_BUILD_OPTIONS,
    );
    const sleepTracedPackageJson = await readTracedServerPackageJson(sleepOutputDir);
    const sleepServerSource = await readJavaScriptModulesRecursively(
      join(sleepOutputDir, "server"),
    );

    expect(sleepServerSource).not.toContain("[Unprintable QuickJS value]");

    const workflowOutputDir = await buildApplication(
      await createWorkflowAssetsApp("workflow", "workflow"),
      DEPLOYABLE_BUILD_OPTIONS,
    );
    const workflowTracedPackageJson = await readTracedServerPackageJson(workflowOutputDir);
    const workflowServerSource = await readJavaScriptModulesRecursively(
      join(workflowOutputDir, "server"),
    );

    expect(workflowServerSource).toContain("[Unprintable QuickJS value]");
    // The generated JavaScript sandbox runtime ships bundled inline, never traced — and
    // these apps do not declare the optional just-bash engine, so its
    // quickjs dependency must not sneak into the trace either.
    expect(sleepTracedPackageJson.dependencies).not.toHaveProperty("run");
    expect(workflowTracedPackageJson.dependencies).not.toHaveProperty("run");
    expect(sleepTracedPackageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
    expect(workflowTracedPackageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
  }, 60_000);

  it("includes the optional just-bash engine in hosted output only when the sandbox config selects it", async () => {
    async function createMinimalApp(input: {
      justBashEngine: boolean;
      label: string;
    }): Promise<string> {
      const appRoot = await createScratchDirectory(`eve-optional-engine-${input.label}-`);
      await mkdir(join(appRoot, "agent"), { recursive: true });
      await writeFile(
        join(appRoot, "package.json"),
        `${JSON.stringify(
          {
            name: `optional-engine-${input.label}-test`,
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(appRoot, "agent", "agent.ts"),
        ["export default {", '  model: "openai/gpt-5.4-mini",', "};", ""].join("\n"),
      );
      await writeFile(join(appRoot, "agent", "instructions.md"), "Optional engine tracing.\n");

      if (input.justBashEngine) {
        // The compiled sandbox config is the opt-in signal. Authored
        // modules resolve `eve/sandbox` through the app's node_modules,
        // so link the workspace package into the scratch app.
        await mkdir(join(appRoot, "node_modules"), { recursive: true });
        await symlink(EVE_PACKAGE_ROOT, join(appRoot, "node_modules", "eve"), "dir");
        await writeFile(
          join(appRoot, "agent", "sandbox.ts"),
          [
            'import { defineSandbox } from "eve/sandbox";',
            'import { JustBashSandbox } from "eve/sandbox/just-bash";',
            "",
            "export const environment = JustBashSandbox.environment();",
            "export default defineSandbox(() => environment.open());",
            "",
          ].join("\n"),
        );
      }
      return appRoot;
    }

    // No just-bash sandbox config: the engine package resolves in this
    // workspace (it is an eve devDependency), but resolvability is not
    // opt-in — nothing of just-bash may reach the hosted output.
    const dockerOutputDir = await buildApplication(
      await createMinimalApp({ justBashEngine: false, label: "docker" }),
      DEPLOYABLE_BUILD_OPTIONS,
    );
    const dockerTraced = await readTracedServerPackageJson(dockerOutputDir);
    expect(dockerTraced.dependencies).not.toHaveProperty("just-bash");
    expect(dockerTraced.dependencies).not.toHaveProperty("quickjs-emscripten");
    expect(existsSync(join(dockerOutputDir, "server", "node_modules", "just-bash"))).toBe(false);
    const dockerEntries = await readdir(join(dockerOutputDir, "server"), {
      recursive: true,
    });
    expect(dockerEntries.filter((entry) => entry.includes("just-bash"))).toEqual([]);

    // Sandbox config selects the engine: the opt-in. The package is
    // externalized and traced so the output stays self-contained.
    const justBashOutputDir = await buildApplication(
      await createMinimalApp({ justBashEngine: true, label: "just-bash" }),
      DEPLOYABLE_BUILD_OPTIONS,
    );
    const justBashTraced = await readTracedServerPackageJson(justBashOutputDir);
    expect(justBashTraced.dependencies).toHaveProperty("just-bash");
    expect(existsSync(join(justBashOutputDir, "server", "node_modules", "just-bash"))).toBe(true);
  }, 120_000);

  it("traces additional hosted build dependencies configured in agent.ts", async () => {
    const appRoot = await createScratchDirectory("eve-app-build-trace-dep-build-");

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });

    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "runtime-dep-trace-config-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      [
        "export default {",
        "  build: {",
        '    externalDependencies: ["fixture-trace-only-dep"],',
        "  },",

        '  model: "openai/gpt-5.4-mini",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, "agent", "instructions.md"),
      "Trace configured runtime dependencies.\n",
    );
    await writeFile(
      join(appRoot, "agent", "tools", "use_fixture_dep.ts"),
      [
        'import fixtureTraceOnlyDep from "fixture-trace-only-dep";',
        "",
        "export default {",
        '  description: "Use the fixture runtime dependency.",',
        "  execute() {",
        "    return fixtureTraceOnlyDep;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const packageRoot = join(appRoot, "node_modules", "fixture-trace-only-dep");

    await mkdir(packageRoot, {
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          name: "fixture-trace-only-dep",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageRoot, "index.js"),
      [
        'export const label = "fixture-trace-only-dep";',
        "export default {",
        "  label,",
        "};",
        "",
      ].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const serverModuleDirectory = join(outputDir, "server");
    const serverModuleEntries = await readdir(serverModuleDirectory, {
      recursive: true,
    });
    const serverModuleSource = (
      await Promise.all(
        serverModuleEntries
          .filter((entry) => entry.endsWith(".mjs"))
          .map((entry) => readFile(join(serverModuleDirectory, entry), "utf8")),
      )
    ).join("\n");

    await expect(
      readFile(
        join(outputDir, "server", "node_modules", "fixture-trace-only-dep", "package.json"),
        "utf8",
      ),
    ).resolves.toContain('"name": "fixture-trace-only-dep"');
    expect(serverModuleSource).toContain('"fixture-trace-only-dep"');
    expect(serverModuleSource).not.toContain('export const label = "fixture-trace-only-dep";');
  }, 30_000);

  it("traces hosted external dependencies configured in agent.ts", async () => {
    const appRoot = await createScratchDirectory("eve-app-build-external-dep-build-");

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });

    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "runtime-dep-external-config-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      [
        "export default {",
        "  build: {",
        '    externalDependencies: ["fixture-external-only-dep", "fixture-external-wrapper"],',
        "  },",

        '  model: "openai/gpt-5.4-mini",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(appRoot, "agent", "instructions.md"),
      "Trace configured external runtime dependencies.\n",
    );
    await writeFile(
      join(appRoot, "agent", "tools", "use_fixture_dep.ts"),
      [
        'import fixtureExternalOnlyDep from "fixture-external-only-dep";',
        'import fixtureExternalWrapper from "fixture-external-wrapper";',
        "",
        "export default {",
        '  description: "Use the fixture external dependency.",',
        "  execute() {",
        "    return { fixtureExternalOnlyDep, fixtureExternalWrapper };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const packageRoot = join(appRoot, "node_modules", "fixture-external-only-dep");
    const wrapperRoot = join(appRoot, "node_modules", "fixture-external-wrapper");
    const nestedPackageRoot = join(wrapperRoot, "node_modules", "fixture-external-only-dep");

    await Promise.all(
      [packageRoot, wrapperRoot, nestedPackageRoot].map((directoryPath) =>
        mkdir(directoryPath, {
          recursive: true,
        }),
      ),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          name: "fixture-external-only-dep",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageRoot, "index.js"),
      [
        'export const label = "fixture-external-only-dep";',
        "export default {",
        "  label,",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(wrapperRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "fixture-external-only-dep": "2.0.0",
          },
          exports: {
            ".": "./index.js",
          },
          name: "fixture-external-wrapper",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(wrapperRoot, "index.js"),
      [
        'import fixtureExternalOnlyDep from "fixture-external-only-dep";',
        "",
        "export default fixtureExternalOnlyDep;",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(nestedPackageRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          name: "fixture-external-only-dep",
          type: "module",
          version: "2.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(nestedPackageRoot, "index.js"),
      [
        'export const label = "fixture-external-only-dep-v2";',
        "export default {",
        "  label,",
        "};",
        "",
      ].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const serverModuleDirectory = join(outputDir, "server");
    const serverModuleEntries = await readdir(serverModuleDirectory, {
      recursive: true,
    });
    const serverModuleSource = (
      await Promise.all(
        serverModuleEntries
          .filter((entry) => entry.endsWith(".mjs"))
          .map((entry) => readFile(join(serverModuleDirectory, entry), "utf8")),
      )
    ).join("\n");

    await expect(
      readFile(
        join(outputDir, "server", "node_modules", "fixture-external-only-dep", "package.json"),
        "utf8",
      ),
    ).resolves.toContain('"name": "fixture-external-only-dep"');
    expect(serverModuleSource).toContain('"fixture-external-only-dep"');
    expect(serverModuleSource).not.toContain('export const label = "fixture-external-only-dep";');

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    const vercelOutputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const rootServerFunctionDirectory = join(vercelOutputDir, "functions", "__server.func");
    const workflowFlowFunctionDirectory = join(
      vercelOutputDir,
      "functions",
      ".well-known",
      "workflow",
      "v1",
      "flow.func",
    );

    for (const functionDirectory of [rootServerFunctionDirectory, workflowFlowFunctionDirectory]) {
      await expect(
        readFile(
          join(functionDirectory, "node_modules", "fixture-external-only-dep", "package.json"),
          "utf8",
        ),
      ).resolves.toContain('"name": "fixture-external-only-dep"');
    }
  }, 30_000);

  it("fails the build when the app cannot resolve an external a workspace package imports", async () => {
    // Hosted output resolves externals from the app. Building this fixture
    // used to succeed and then fail at boot with ERR_MODULE_NOT_FOUND.
    const { appRoot } = await writeWorkspaceExternalFixture({ appDeclaresExternal: false });

    const build = buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(build).rejects.toThrow(
      /"fixture-workspace-external" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
    await expect(build).rejects.toThrow(
      /Add "fixture-workspace-external" to the dependencies in \S*\/apps\/agent\/package\.json\./,
    );
  }, 60_000);

  it("fails the build when a literal dynamic import needs an external the output lacks", async () => {
    const { appRoot } = await writeWorkspaceExternalFixture({
      appDeclaresExternal: false,
      dynamicImport: true,
    });

    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      /"fixture-workspace-external" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
  }, 60_000);

  it("ships a workspace package's external once the app declares it", async () => {
    const { appRoot } = await writeWorkspaceExternalFixture({ appDeclaresExternal: true });

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(importRelocatedWorkspaceExternal(outputDir)).resolves.toBe("workspace external");
  }, 60_000);

  it("fails the build when only a mounted extension declares the missing external", async () => {
    // A mounted extension declares the external and installs its own copy,
    // but nothing makes Nitro's tracer copy it. This used to build and then
    // fail to resolve from the relocated output.
    const { appRoot } = await writeWorkspaceExternalFixture({ appDeclaresExternal: false });
    await writeMountedExtensionDeclaringExternal(appRoot, { exportsPackageJson: false });
    await mkdir(join(appRoot, "agent", "instrumentation"), { recursive: true });
    await writeFile(
      join(appRoot, "agent", "instrumentation", "provider.ts"),
      [
        'import { value } from "@fixture/backend";',
        "",
        "export default {",
        "  setup() {",
        "    (globalThis as Record<string, unknown>).__workspaceExternal = value;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const compiled = await compileAgent({ startPath: join(appRoot, "agent") });
    expect(compiled.manifest.extensionMounts.map((mount) => mount.externalDependencies)).toEqual([
      ["fixture-workspace-external"],
    ]);

    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      /"fixture-workspace-external" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
  }, 60_000);

  it("fails the build when the packaged version does not export the imported subpath", async () => {
    // The workspace package imports a v2-only subpath; the mounted extension's
    // v1 copy is what Nitro packages. This used to build and then fail at boot
    // with ERR_PACKAGE_PATH_NOT_EXPORTED.
    const { appRoot } = await writeWorkspaceExternalFixture({
      appDeclaresExternal: false,
      subpathImport: true,
    });
    await writeMountedExtensionDeclaringExternal(appRoot, { exportsPackageJson: true });

    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      /"fixture-workspace-external\/extra" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
  }, 60_000);

  it("ships the imported subpath once the app declares the version that exports it", async () => {
    const { appRoot } = await writeWorkspaceExternalFixture({
      appDeclaresExternal: true,
      subpathImport: true,
    });
    await writeMountedExtensionDeclaringExternal(appRoot, { exportsPackageJson: true });

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(
      importRelocatedWorkspaceExternal(outputDir, "fixture-workspace-external/extra"),
    ).resolves.toBe("workspace extra");
  }, 60_000);

  it("fails the build when Node selects a conditional export the output lacks", async () => {
    // Node's ESM loader selects `node-addons` by default; Nitro's tracer
    // copies only the `import` target. This used to build and then fail at
    // boot with ERR_MODULE_NOT_FOUND.
    const { appRoot } = await writeWorkspaceExternalFixture({
      appDeclaresExternal: true,
      exportCondition: "node-addons",
    });

    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      /"fixture-workspace-external" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
  }, 60_000);

  it("ships the conditional export Node selects when the output contains it", async () => {
    const { appRoot } = await writeWorkspaceExternalFixture({
      appDeclaresExternal: true,
      exportCondition: "node",
    });

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(importRelocatedWorkspaceExternal(outputDir)).resolves.toBe(
      "workspace external (node)",
    );
  }, 60_000);

  it("rewrites framework tool executors into hosted Vercel output", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    const appRoot = await createScratchDirectory("eve-app-hosted-framework-tools-build-");

    await mkdir(join(appRoot, "agent", "skills"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "hosted-framework-tool-build-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      [
        "export default {",

        '  model: "openai/gpt-5.4-mini",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Test hosted framework tools.\n");
    await writeFile(
      join(appRoot, "agent", "skills", "weather.md"),
      ["---", "description: Weather help.", "---", ""].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const serverFunctionDirectory = join(outputDir, "functions", "__server.func");
    const functionEntries = await readdir(join(outputDir, "functions"), {
      recursive: true,
    });
    const serverEntries = await readdir(serverFunctionDirectory, {
      recursive: true,
    });
    const serverModuleSource = (
      await Promise.all(
        serverEntries
          .filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".js"))
          .map((entry) => readFile(join(serverFunctionDirectory, entry), "utf8")),
      )
    ).join("\n");

    expect(serverModuleSource).not.toContain("../execution/sandbox/bash.js");
    expect(serverModuleSource).not.toContain("../execution/skills/activate.js");
    expect(serverModuleSource).not.toContain("../execution/web-fetch/execute.js");
    expect(functionEntries.some((entry) => entry.includes("node_modules/esbuild"))).toBe(false);
    expect(functionEntries.some((entry) => entry.includes("node_modules/.nf3/esbuild"))).toBe(
      false,
    );
    expect(functionEntries.some((entry) => entry.includes("node_modules/rolldown"))).toBe(false);
    expect(functionEntries.some((entry) => entry.includes("node_modules/.nf3/rolldown"))).toBe(
      false,
    );
    expect(serverModuleSource).not.toContain('import("esbuild")');
    expect(serverModuleSource).not.toContain('import("rolldown")');
    expect(serverModuleSource).toContain(
      "Execute a shell command in the shared workspace environment.",
    );
    expect(serverModuleSource).toContain("is a connection, not a skill.");
    expect(serverModuleSource).toContain("URL must start with https://");
  }, 30_000);

  it.each([
    { name: "hosted Vercel", vercel: true },
    { name: "self-hosted production", vercel: false },
  ])(
    "does not bundle local-only runtime infrastructure into $name output",
    async ({ vercel }) => {
      if (vercel) {
        vi.stubEnv("VERCEL", "1");
        vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
      }

      const appRoot = await createScratchDirectory(
        `eve-app-${vercel ? "hosted" : "self-hosted"}-no-dev-runtime-build-`,
      );

      await mkdir(join(appRoot, "agent"), {
        recursive: true,
      });
      await writeFile(
        join(appRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "hosted-no-dev-runtime-build-test",
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(appRoot, "agent", "agent.ts"),
        ["export default {", '  model: "openai/gpt-5.4-mini",', "};", ""].join("\n"),
      );
      await writeFile(
        join(appRoot, "agent", "instructions.md"),
        "Verify deployed runtime contents.\n",
      );

      const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
      const runtimeSource = await readJavaScriptModulesRecursively(
        join(outputDir, vercel ? "functions" : "server"),
      );

      expect(runtimeSource).not.toContain("dev-authored-source-watcher");
      expect(runtimeSource).not.toContain("chokidar");
      expect(runtimeSource).not.toContain("[eve:dev]");
      expect(runtimeSource).not.toContain("rollup:reload");
      // The world-local canary is its log prefix, not names other packages
      // legitimately mention without bundling world-local code: the
      // semantic-error catalog embeds error-class names like
      // `DataDirAccessError`, and @workflow/core's runtime world factory
      // (stubbed out at vendor time) names `WORKFLOW_LOCAL_DATA_DIR`.
      if (vercel) {
        expect(runtimeSource).not.toContain("[world-local]");

        vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_hosted_no_dev_runtime_test");
        const serverModule = (await import(
          `${pathToFileURL(join(outputDir, "functions", "__server.func", "index.mjs")).href}?test=${Date.now()}`
        )) as {
          default: {
            fetch(request: Request, context: { waitUntil(): void }): Promise<Response>;
          };
        };
        const healthResponse = await serverModule.default.fetch(
          new Request("https://example.com/eve/v1/health"),
          { waitUntil() {} },
        );
        expect(healthResponse.status).toBe(200);
      }
    },
    30_000,
  );

  it("loads instrumentation runtime dependencies from hosted Vercel output", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    const appRoot = await createScratchDirectory("eve-app-hosted-instrumentation-dep-build-");

    await mkdir(join(appRoot, "agent"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "fixture-instrumentation-dep": "1.0.0",
          },
          name: "hosted-instrumentation-dep-build-test",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appRoot, "agent", "agent.ts"),
      ["export default {", '  model: "openai/gpt-5.4-mini",', "};", ""].join("\n"),
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Verify hosted instrumentation.\n");
    await mkdir(join(appRoot, "agent", "instrumentation"), { recursive: true });
    await writeFile(
      join(appRoot, "agent", "instrumentation", "dependency.ts"),
      [
        'import fixtureInstrumentationDep from "fixture-instrumentation-dep";',
        'import { defineInstrumentation } from "eve/instrumentation";',
        "",
        "export default defineInstrumentation({",
        "  setup() {",
        "    (globalThis as Record<string, unknown>).__fixtureInstrumentationDep =",
        "      fixtureInstrumentationDep;",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const runtimeDependencyRoot = join(appRoot, "node_modules", "fixture-instrumentation-dep");
    const runtimeDependencyHelperRoot = join(
      appRoot,
      "node_modules",
      "fixture-instrumentation-helper",
    );

    await mkdir(runtimeDependencyRoot, {
      recursive: true,
    });
    await mkdir(runtimeDependencyHelperRoot, {
      recursive: true,
    });
    await writeFile(
      join(runtimeDependencyRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          dependencies: {
            "fixture-instrumentation-helper": "1.0.0",
          },
          name: "fixture-instrumentation-dep",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(runtimeDependencyRoot, "index.js"),
      [
        'import helper from "fixture-instrumentation-helper";',
        "",
        "export default helper;",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(runtimeDependencyHelperRoot, "package.json"),
      JSON.stringify(
        {
          exports: {
            ".": "./index.js",
          },
          name: "fixture-instrumentation-helper",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(runtimeDependencyHelperRoot, "index.js"),
      [
        'export const label = "fixture-instrumentation-helper";',
        "export default {",
        "  label,",
        "};",
        "",
      ].join("\n"),
    );

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    const serverFunctionDirectory = join(outputDir, "functions", "__server.func");
    const serverEntries = await readdir(serverFunctionDirectory, {
      recursive: true,
    });

    const instrumentationModulePath = (
      await Promise.all(
        serverEntries
          .filter((entry) => !entry.startsWith("node_modules/"))
          .filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".js"))
          .map(async (entry) => {
            const source = await readFile(join(serverFunctionDirectory, entry), "utf8");

            return source.includes("__fixtureInstrumentationDep") ||
              source.includes("fixture-instrumentation-dep")
              ? join(serverFunctionDirectory, entry)
              : null;
          }),
      )
    ).find((entry) => entry !== null);

    expect(instrumentationModulePath).toBeDefined();

    if (instrumentationModulePath === undefined) {
      throw new Error("Expected hosted output to retain the authored instrumentation module.");
    }

    await import(pathToFileURL(instrumentationModulePath).href);
    expect((globalThis as Record<string, unknown>).__fixtureInstrumentationDep).toEqual({
      label: "fixture-instrumentation-helper",
    });
  }, 30_000);
});
