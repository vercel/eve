import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePackageRoot } from "../../src/internal/application/package.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

vi.mock("../../src/internal/nitro/host/vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: async () => true,
}));

const EVE_PACKAGE_ROOT = resolvePackageRoot();
const createScratchDirectory = useTemporaryDirectories({ scope: "file" });
const DEPLOYABLE_BUILD_OPTIONS = { skipSandboxPrewarm: false } as const;

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

function packageFiles(input: {
  readonly name: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly index: string;
}): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      dependencies: input.dependencies,
      exports: { ".": "./index.js" },
      name: input.name,
      type: "module",
      version: input.version ?? "1.0.0",
    }),
    "index.js": input.index,
  };
}

async function readPackageName(packageJsonPath: string): Promise<unknown> {
  return (JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown }).name;
}

async function readServerSource(outputDir: string): Promise<string> {
  const serverDirectory = join(outputDir, "server");
  const entries = await readdir(serverDirectory, { recursive: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".mjs") && !entry.includes("node_modules"))
        .map((entry) => readFile(join(serverDirectory, entry), "utf8")),
    )
  ).join("\n");
}

/**
 * Writes an isolated (pnpm-style, nothing hoisted) workspace: `apps/agent`
 * depends on the `packages/backend` source package, which installs
 * `fixture-workspace-external` in its own node_modules. The agent marks it
 * external; with `appDeclaresExternal` the app installs it too.
 */
async function writeWorkspaceExternalFixture(input: {
  readonly appDeclaresExternal: boolean;
}): Promise<string> {
  const workspaceRoot = await createScratchDirectory("eve-workspace-external-dep-build-");
  const appRoot = join(workspaceRoot, "apps", "agent");
  const packageRoot = join(workspaceRoot, "packages", "backend");
  const external = packageFiles({
    name: "fixture-workspace-external",
    index: 'export const value = "workspace external";\n',
  });

  const appDependencies: Record<string, string> = { "@fixture/backend": "workspace:*" };
  if (input.appDeclaresExternal) {
    appDependencies["fixture-workspace-external"] = "1.0.0";
  }
  await writeFiles(appRoot, {
    "package.json": JSON.stringify({
      dependencies: appDependencies,
      name: "workspace-external-dependency-app",
      private: true,
      type: "module",
    }),
    "agent/agent.ts": [
      'import { defineAgent } from "eve";',
      "export default defineAgent({",
      '  build: { externalDependencies: ["fixture-workspace-external"] },',
      '  model: "openai/gpt-5.4-mini",',
      "});",
      "",
    ].join("\n"),
    "agent/instructions.md": "Workspace external dependency.\n",
    "agent/tools/use_backend.ts": [
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
  });
  if (input.appDeclaresExternal) {
    await writeFiles(join(appRoot, "node_modules", "fixture-workspace-external"), external);
  }
  await writeFiles(packageRoot, {
    "package.json": JSON.stringify({
      dependencies: { "fixture-workspace-external": "1.0.0" },
      exports: "./src/index.ts",
      name: "@fixture/backend",
      private: true,
      type: "module",
    }),
    "src/index.ts": 'export { value } from "fixture-workspace-external";\n',
  });
  await writeFiles(join(packageRoot, "node_modules", "fixture-workspace-external"), external);
  await mkdir(join(appRoot, "node_modules", "@fixture"), { recursive: true });
  await symlink(packageRoot, join(appRoot, "node_modules", "@fixture", "backend"), "dir");
  return appRoot;
}

/**
 * Copies the build output away from the workspace, so no source installation
 * is reachable, then imports the external in Node by its bare specifier from
 * beside the chunk that imports it, exactly as the bundled module does.
 */
async function importRelocatedExternal(outputDir: string, specifier: string): Promise<unknown> {
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
          // An import statement, not a mention in the embedded manifest.
          return (await readFile(path, "utf8")).includes(`from "${specifier}"`) ? path : null;
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

describe("configured external dependencies", () => {
  let appRoot: string;
  let outputDir: string;

  beforeAll(async () => {
    appRoot = await createScratchDirectory("eve-app-build-external-dep-build-");
    await writeFiles(appRoot, {
      "package.json": JSON.stringify({
        name: "runtime-dep-external-config-test",
        private: true,
        type: "module",
      }),
      "agent/agent.ts": [
        'import { defineAgent } from "eve";',
        "export default defineAgent({",
        "  build: {",
        "    externalDependencies: [",
        '      "fixture-external-only-dep",',
        '      "fixture-external-wrapper",',
        '      "fixture-dynamic-subagent-dep",',
        "    ],",
        "  },",
        '  model: "openai/gpt-5.4-mini",',
        "});",
        "",
      ].join("\n"),
      "agent/instructions.md": "Trace configured external runtime dependencies.\n",
      "agent/tools/use_fixture_dep.ts": [
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
      "agent/subagents/analyst/agent.ts": [
        'import { defineAgent, defineDynamic } from "eve";',
        'import { label } from "fixture-dynamic-subagent-dep";',
        "",
        "export default defineDynamic(() =>",
        '  defineAgent({ description: `Analyst for ${label}.`, model: "openai/gpt-5.4-mini" }),',
        ");",
        "",
      ].join("\n"),
    });
    await writeFiles(
      join(appRoot, "node_modules", "fixture-external-only-dep"),
      packageFiles({
        name: "fixture-external-only-dep",
        index: 'export const label = "fixture-external-only-dep";\nexport default { label };\n',
      }),
    );
    // The wrapper installs its own v2 copy of the external beside the root v1 copy.
    await writeFiles(
      join(appRoot, "node_modules", "fixture-external-wrapper"),
      packageFiles({
        dependencies: { "fixture-external-only-dep": "2.0.0" },
        name: "fixture-external-wrapper",
        index:
          'import fixtureExternalOnlyDep from "fixture-external-only-dep";\n\nexport default fixtureExternalOnlyDep;\n',
      }),
    );
    await writeFiles(
      join(
        appRoot,
        "node_modules",
        "fixture-external-wrapper",
        "node_modules",
        "fixture-external-only-dep",
      ),
      packageFiles({
        name: "fixture-external-only-dep",
        version: "2.0.0",
        index: 'export const label = "fixture-external-only-dep-v2";\nexport default { label };\n',
      }),
    );
    await writeFiles(
      join(appRoot, "node_modules", "fixture-dynamic-subagent-dep"),
      packageFiles({
        name: "fixture-dynamic-subagent-dep",
        index: 'export const label = "fixture-dynamic-subagent-dep";\n',
      }),
    );
    await symlink(EVE_PACKAGE_ROOT, join(appRoot, "node_modules", "eve"), "dir");
    outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);
  }, 60_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("traces a configured external into self-hosted output and keeps its import external", async () => {
    const serverSource = await readServerSource(outputDir);

    await expect(
      readPackageName(
        join(outputDir, "server", "node_modules", "fixture-external-only-dep", "package.json"),
      ),
    ).resolves.toBe("fixture-external-only-dep");
    expect(serverSource).toContain('"fixture-external-only-dep"');
    expect(serverSource).not.toContain('export const label = "fixture-external-only-dep";');
  });

  it("ships an external a dynamic subagent imports once the root agent declares it", async () => {
    const serverSource = await readServerSource(outputDir);

    await expect(
      readPackageName(
        join(outputDir, "server", "node_modules", "fixture-dynamic-subagent-dep", "package.json"),
      ),
    ).resolves.toBe("fixture-dynamic-subagent-dep");
    expect(serverSource).toContain('import { label } from "fixture-dynamic-subagent-dep";');
    expect(serverSource).not.toContain('export const label = "fixture-dynamic-subagent-dep";');
  });

  it("copies configured externals into every hosted Vercel function", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    const vercelOutputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    for (const functionDirectory of [
      join(vercelOutputDir, "functions", "__server.func"),
      join(vercelOutputDir, "functions", ".well-known", "workflow", "v1", "flow.func"),
    ]) {
      await expect(
        readPackageName(
          join(functionDirectory, "node_modules", "fixture-external-only-dep", "package.json"),
        ),
      ).resolves.toBe("fixture-external-only-dep");
    }
  }, 60_000);
});

describe("workspace package externals", () => {
  it("fails the build when the app cannot resolve an external a workspace package imports", async () => {
    // Hosted output resolves externals from the app. Building this fixture
    // used to succeed and then fail at boot with ERR_MODULE_NOT_FOUND.
    const appRoot = await writeWorkspaceExternalFixture({ appDeclaresExternal: false });

    const build = buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(build).rejects.toThrow(
      /"fixture-workspace-external" is listed in build\.externalDependencies and imported by the hosted bundle \(.+\), but the build output cannot resolve it\./,
    );
    await expect(build).rejects.toThrow(
      /Add "fixture-workspace-external" to the dependencies in \S*\/apps\/agent\/package\.json\./,
    );
  }, 60_000);

  it("ships a workspace package's external once the app declares it", async () => {
    const appRoot = await writeWorkspaceExternalFixture({ appDeclaresExternal: true });

    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expect(importRelocatedExternal(outputDir, "fixture-workspace-external")).resolves.toBe(
      "workspace external",
    );
  }, 60_000);
});
