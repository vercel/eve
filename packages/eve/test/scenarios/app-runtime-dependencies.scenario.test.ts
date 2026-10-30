import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
} from "../../src/internal/application/package.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

vi.mock("../../src/internal/nitro/host/vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: async () => true,
}));

const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const EVE_PACKAGE_ROOT = resolvePackageRoot();
const createScratchDirectory = useTemporaryDirectories({ scope: "file" });
const DEPLOYABLE_BUILD_OPTIONS = { skipSandboxPrewarm: false } as const;

/** Every `.mjs`/`.js` file under `rootDirectory`, keyed by path. */
async function readJavaScriptModules(rootDirectory: string): Promise<Map<string, string>> {
  // `withFileTypes` so directories named like modules (for example the
  // traced `sql.js` package directory) are not read as files.
  const entries = await readdir(rootDirectory, { recursive: true, withFileTypes: true });
  const modules = new Map<string, string>();
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) {
      const path = join(entry.parentPath, entry.name);
      modules.set(path, await readFile(path, "utf8"));
    }
  }
  return modules;
}

async function readJavaScriptSource(rootDirectory: string): Promise<string> {
  return [...(await readJavaScriptModules(rootDirectory)).values()].join("\n");
}

async function readTracedDependencies(outputDir: string): Promise<Record<string, string>> {
  const path = join(outputDir, "server", "package.json");
  if (!existsSync(path)) {
    return {};
  }
  const packageJson = JSON.parse(await readFile(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return packageJson.dependencies ?? {};
}

async function writePackage(
  root: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, name), source);
  }
}

async function writeApp(input: {
  readonly label: string;
  readonly dependencies?: Record<string, string>;
  readonly files: Record<string, string>;
}): Promise<string> {
  const appRoot = await createScratchDirectory(`eve-app-${input.label}-build-`);
  await writePackage(
    appRoot,
    {
      dependencies: input.dependencies ?? {},
      name: `${input.label}-test`,
      private: true,
      type: "module",
    },
    {},
  );
  const files = {
    "agent/agent.ts":
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n',
    "agent/instructions.md": `Verify ${input.label} output.\n`,
    ...input.files,
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true });
    await writeFile(join(appRoot, path), source);
  }
  return appRoot;
}

function expectNoLocalRuntimeInfrastructure(runtimeSource: string): void {
  expect(runtimeSource).not.toContain("dev-authored-source-watcher");
  expect(runtimeSource).not.toContain("chokidar");
  expect(runtimeSource).not.toContain("[eve:dev]");
  expect(runtimeSource).not.toContain("rollup:reload");
}

describe("self-hosted production output", () => {
  let outputDir: string;

  beforeAll(async () => {
    const appRoot = await writeApp({
      label: "self-hosted",
      dependencies: {
        "fixture-cjs-path-globals-dep": "1.0.0",
        "fixture-runtime-dep": "1.0.0",
      },
      files: {
        "agent/tools/use_runtime_dep.ts": [
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
        "agent/tools/use_cjs_dep.ts": [
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
      },
    });
    await writePackage(
      join(appRoot, "node_modules", "fixture-runtime-dep"),
      {
        exports: { ".": "./index.js" },
        name: "fixture-runtime-dep",
        type: "module",
        version: "1.0.0",
      },
      {
        "index.js": 'export const label = "fixture-runtime-dep";\nexport default {\n  label,\n};\n',
      },
    );
    await writePackage(
      join(appRoot, "node_modules", "fixture-cjs-path-globals-dep"),
      {
        exports: { ".": "./index.cjs" },
        main: "./index.cjs",
        name: "fixture-cjs-path-globals-dep",
        version: "1.0.0",
      },
      {
        "index.cjs": [
          'const path = require("node:path");',
          "",
          "module.exports = {",
          "  dirnameBasename: path.basename(__dirname),",
          "  filenameBasename: path.basename(__filename),",
          "};",
          "",
        ].join("\n"),
      },
    );
    outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
  }, 60_000);

  it("bundles authored app runtime dependencies without traced node_modules copies", async () => {
    const tracedDependencies = await readTracedDependencies(outputDir);
    const serverSource = await readJavaScriptSource(join(outputDir, "server"));

    expect(tracedDependencies).not.toHaveProperty("fixture-runtime-dep");
    expect(tracedDependencies).not.toHaveProperty(EVE_PACKAGE_INFO.name);
    expect(existsSync(join(outputDir, "server", "node_modules", "fixture-runtime-dep"))).toBe(
      false,
    );
    expect(serverSource).toContain('"fixture-runtime-dep"');
    expect(serverSource).not.toContain('export const label = "fixture-runtime-dep";');
  });

  it("provides CommonJS path globals to bundled dependencies", async () => {
    const bundledDependencyModule = [
      ...(await readJavaScriptModules(join(outputDir, "server"))).entries(),
    ].find(([, source]) => source.includes("dirnameBasename"));

    expect(bundledDependencyModule).toBeDefined();
    expect(
      existsSync(join(outputDir, "server", "node_modules", "fixture-cjs-path-globals-dep")),
    ).toBe(false);
    await import(pathToFileURL(bundledDependencyModule![0]).href);
  });

  it("leaves out the generated JavaScript sandbox and just-bash when nothing selects them", async () => {
    // The just-bash engine resolves in this workspace (it is an eve
    // devDependency), but resolvability is not opt-in.
    const tracedDependencies = await readTracedDependencies(outputDir);
    const serverEntries = await readdir(join(outputDir, "server"), { recursive: true });

    expect(await readJavaScriptSource(join(outputDir, "server"))).not.toContain(
      "[Unprintable QuickJS value]",
    );
    expect(tracedDependencies).not.toHaveProperty("run");
    expect(tracedDependencies).not.toHaveProperty("just-bash");
    expect(tracedDependencies).not.toHaveProperty("quickjs-emscripten");
    expect(serverEntries.filter((entry) => entry.includes("just-bash"))).toEqual([]);
  });

  it("does not bundle local-only runtime infrastructure", async () => {
    expectNoLocalRuntimeInfrastructure(await readJavaScriptSource(join(outputDir, "server")));
  });
});

describe("hosted Vercel output", () => {
  let outputDir: string;

  beforeAll(async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const appRoot = await writeApp({
      label: "hosted",
      dependencies: { "fixture-instrumentation-dep": "1.0.0" },
      files: {
        "agent/skills/weather.md": "---\ndescription: Weather help.\n---\n",
        "agent/instrumentation/dependency.ts": [
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
      },
    });
    await writePackage(
      join(appRoot, "node_modules", "fixture-instrumentation-dep"),
      {
        dependencies: { "fixture-instrumentation-helper": "1.0.0" },
        exports: { ".": "./index.js" },
        name: "fixture-instrumentation-dep",
        type: "module",
        version: "1.0.0",
      },
      {
        "index.js":
          'import helper from "fixture-instrumentation-helper";\n\nexport default helper;\n',
      },
    );
    await writePackage(
      join(appRoot, "node_modules", "fixture-instrumentation-helper"),
      {
        exports: { ".": "./index.js" },
        name: "fixture-instrumentation-helper",
        type: "module",
        version: "1.0.0",
      },
      {
        "index.js":
          'export const label = "fixture-instrumentation-helper";\nexport default {\n  label,\n};\n',
      },
    );
    outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
    vi.unstubAllEnvs();
  }, 60_000);

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__fixtureInstrumentationDep;
    vi.unstubAllEnvs();
  });

  it("rewrites framework tool executors into the server function", async () => {
    const functionEntries = await readdir(join(outputDir, "functions"), { recursive: true });
    const serverSource = await readJavaScriptSource(join(outputDir, "functions", "__server.func"));

    expect(serverSource).not.toContain("../execution/sandbox/bash.js");
    expect(serverSource).not.toContain("../execution/skills/activate.js");
    expect(serverSource).not.toContain("../execution/web-fetch/execute.js");
    for (const bundler of ["esbuild", "rolldown"]) {
      expect(functionEntries.some((entry) => entry.includes(`node_modules/${bundler}`))).toBe(
        false,
      );
      expect(functionEntries.some((entry) => entry.includes(`node_modules/.nf3/${bundler}`))).toBe(
        false,
      );
      expect(serverSource).not.toContain(`import("${bundler}")`);
    }
    expect(serverSource).toContain("Execute a shell command in the shared workspace environment.");
    expect(serverSource).toContain("is a connection, not a skill.");
    expect(serverSource).toContain("URL must start with https://");
  });

  it("serves health without local-only runtime infrastructure", async () => {
    const runtimeSource = await readJavaScriptSource(join(outputDir, "functions"));
    expectNoLocalRuntimeInfrastructure(runtimeSource);
    // The world-local canary is its log prefix, not names other packages
    // legitimately mention without bundling world-local code: the
    // semantic-error catalog embeds error-class names like
    // `DataDirAccessError`, and @workflow/core's runtime world factory
    // (stubbed out at vendor time) names `WORKFLOW_LOCAL_DATA_DIR`.
    expect(runtimeSource).not.toContain("[world-local]");
    expect(runtimeSource).not.toContain("[Unprintable QuickJS value]");

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_hosted_no_dev_runtime_test");
    const serverModule = (await import(
      `${pathToFileURL(join(outputDir, "functions", "__server.func", "index.mjs")).href}?test=${Date.now()}`
    )) as {
      default: { fetch(request: Request, context: { waitUntil(): void }): Promise<Response> };
    };
    const healthResponse = await serverModule.default.fetch(
      new Request("https://example.com/eve/v1/health"),
      { waitUntil() {} },
    );
    expect(healthResponse.status).toBe(200);
  });

  it("loads instrumentation runtime dependencies from the server function", async () => {
    const serverFunctionDirectory = join(outputDir, "functions", "__server.func");
    const instrumentationModule = [
      ...(await readJavaScriptModules(serverFunctionDirectory)).entries(),
    ].find(
      ([path, source]) =>
        !path.startsWith(join(serverFunctionDirectory, "node_modules")) &&
        (source.includes("__fixtureInstrumentationDep") ||
          source.includes("fixture-instrumentation-dep")),
    );

    expect(instrumentationModule).toBeDefined();
    await import(pathToFileURL(instrumentationModule![0]).href);
    expect((globalThis as Record<string, unknown>).__fixtureInstrumentationDep).toEqual({
      label: "fixture-instrumentation-helper",
    });
  });
});

describe("the workflow factory", () => {
  let outputDir: string;

  beforeAll(async () => {
    const appRoot = await writeApp({
      label: "workflow-factory",
      files: {
        "agent/subagents/researcher/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ description: "Research.", model: "openai/gpt-5.4-mini" });\n',
        "agent/subagents/researcher/instructions.md": "Research the request.\n",
        "agent/tools/workflow.ts":
          'import { workflow } from "eve/tools/workflow";\n\nexport default workflow({ agents: ["researcher"], maxSubagents: 6 });\n',
      },
    });
    outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
  }, 60_000);

  it("bundles the generated JavaScript sandbox inline, never traced", async () => {
    const tracedDependencies = await readTracedDependencies(outputDir);

    expect(await readJavaScriptSource(join(outputDir, "server"))).toContain(
      "[Unprintable QuickJS value]",
    );
    expect(tracedDependencies).not.toHaveProperty("run");
    expect(tracedDependencies).not.toHaveProperty("quickjs-emscripten");
  });
});

describe("a just-bash sandbox config", () => {
  it("traces the just-bash engine into the output", async () => {
    const appRoot = await writeApp({
      label: "just-bash",
      files: {
        // The compiled sandbox config is the opt-in signal.
        "agent/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          'import { JustBashSandbox } from "eve/sandbox/just-bash";',
          "",
          "export const environment = JustBashSandbox.environment();",
          "export default defineSandbox(() => environment.open());",
          "",
        ].join("\n"),
      },
    });
    // Authored modules resolve `eve/sandbox` through the app's node_modules.
    await mkdir(join(appRoot, "node_modules"), { recursive: true });
    await symlink(EVE_PACKAGE_ROOT, join(appRoot, "node_modules", "eve"), "dir");

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(await readTracedDependencies(outputDir)).toHaveProperty("just-bash");
    expect(existsSync(join(outputDir, "server", "node_modules", "just-bash"))).toBe(true);
  }, 60_000);
});
