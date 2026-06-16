import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
} from "../../src/internal/application/package.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const EVE_PACKAGE_ROOT = resolvePackageRoot();
const createScratchDirectory = useTemporaryDirectories();

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

    const outputDir = await buildApplication(appRoot);
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

    expect(serverModuleEntries.some((entry) => entry.includes("fixture-runtime-dep"))).toBe(true);
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

    const outputDir = await buildApplication(appRoot);
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
    expect(bundledDependencyModule.source).toContain("const __dirname = __eveDirname(__filename);");

    await import(pathToFileURL(bundledDependencyModule.modulePath).href);
  }, 30_000);

  it("bundles code-mode inline worker assets only when an agent enables code mode", async () => {
    async function createCodeModeAssetsApp(label: string, codeMode: boolean): Promise<string> {
      const appRoot = await createScratchDirectory(`eve-app-code-mode-assets-${label}-build-`);

      await mkdir(join(appRoot, "agent"), {
        recursive: true,
      });

      await writeFile(
        join(appRoot, "package.json"),
        `${JSON.stringify(
          {
            name: `code-mode-assets-${label}-test`,
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
      );
      const agentLines = ["export default {", '  model: "openai/gpt-5.4-mini",'];
      if (codeMode) {
        agentLines.push("  experimental: { codeMode: true },");
      }
      agentLines.push("};", "");
      await writeFile(join(appRoot, "agent", "agent.ts"), agentLines.join("\n"));
      await writeFile(join(appRoot, "agent", "instructions.md"), "Trace code-mode assets.\n");

      return appRoot;
    }

    vi.stubEnv("EVE_EXPERIMENTAL_CODE_MODE", undefined);
    const disabledOutputDir = await buildApplication(
      await createCodeModeAssetsApp("disabled", false),
    );
    const disabledTracedPackageJson = await readTracedServerPackageJson(disabledOutputDir);
    const disabledServerSource = await readJavaScriptModulesRecursively(
      join(disabledOutputDir, "server"),
    );

    expect(disabledServerSource).not.toContain("[Unprintable QuickJS value]");

    const enabledOutputDir = await buildApplication(await createCodeModeAssetsApp("enabled", true));
    const tracedServerPackageJson = await readTracedServerPackageJson(enabledOutputDir);
    const enabledServerSource = await readJavaScriptModulesRecursively(
      join(enabledOutputDir, "server"),
    );

    expect(enabledServerSource).toContain("[Unprintable QuickJS value]");
    // The code-mode runtime ships bundled inline, never traced — and
    // these apps do not declare the optional just-bash engine, so its
    // quickjs dependency must not sneak into the trace either.
    expect(disabledTracedPackageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
    expect(tracedServerPackageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
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
            'import { justbash } from "eve/sandbox/just-bash";',
            "",
            "export default defineSandbox({",
            "  backend: justbash(),",
            "});",
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

    const outputDir = await buildApplication(appRoot);
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
        '    externalDependencies: ["fixture-external-only-dep"],',
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
        "",
        "export default {",
        '  description: "Use the fixture external dependency.",',
        "  execute() {",
        "    return fixtureExternalOnlyDep;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const packageRoot = join(appRoot, "node_modules", "fixture-external-only-dep");

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

    const outputDir = await buildApplication(appRoot);
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
  }, 30_000);

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

    const outputDir = await buildApplication(appRoot);
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

    expect(serverModuleSource).not.toContain("../execution/sandbox/bash-tool.js");
    expect(serverModuleSource).not.toContain("../execution/skills/activate.js");
    expect(serverModuleSource).not.toContain("../execution/web-fetch/tool.js");
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
      "This tool requires sandbox access on the runtime context.",
    );
    expect(serverModuleSource).toContain(
      "The load_skill tool requires sandbox access on the runtime context.",
    );
    expect(serverModuleSource).toContain("URL must start with http:// or https://");
  }, 30_000);

  it("does not bundle dev-only watcher handling into hosted Vercel server output", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    const appRoot = await createScratchDirectory("eve-app-hosted-no-dev-runtime-build-");

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

    const outputDir = await buildApplication(appRoot);
    const vercelFunctionsSource = await readJavaScriptModulesRecursively(
      join(outputDir, "functions"),
    );

    expect(vercelFunctionsSource).not.toContain("dev-authored-source-watcher");
    expect(vercelFunctionsSource).not.toContain("chokidar");
    expect(vercelFunctionsSource).not.toContain("[eve:dev]");
    expect(vercelFunctionsSource).not.toContain("rollup:reload");
  }, 30_000);

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
    await writeFile(
      join(appRoot, "agent", "instrumentation.ts"),
      [
        'import fixtureInstrumentationDep from "fixture-instrumentation-dep";',
        "",
        "(globalThis as Record<string, unknown>).__fixtureInstrumentationDep =",
        "  fixtureInstrumentationDep;",
        "",
        "export default fixtureInstrumentationDep;",
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

    const outputDir = await buildApplication(appRoot);
    const serverFunctionDirectory = join(outputDir, "functions", "__server.func");
    const serverEntries = await readdir(serverFunctionDirectory, {
      recursive: true,
    });

    expect(serverEntries.some((entry) => entry.includes("fixture-instrumentation-dep"))).toBe(true);
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
