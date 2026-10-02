import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceExtensions } from "#internal/nitro/host/workspace-extensions.js";

// These run the real extension publisher (rolldown and TypeScript), so they
// belong to the scenario tier.
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

describe("buildWorkspaceExtensions", () => {
  it("skips an unchanged extension after a first build adds its package exports", async () => {
    const { appRoot, packageRoot } = await createWorkspaceAgent();
    const manifestPath = join(packageRoot, "dist", "extension", "_manifest.json");

    await buildWorkspaceExtensions(appRoot);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(packageJson.exports).toBeDefined();
    const firstBuild = await stat(manifestPath);

    await buildWorkspaceExtensions(appRoot);
    const secondBuild = await stat(manifestPath);

    expect(secondBuild.ino).toBe(firstBuild.ino);
    expect(secondBuild.mtimeMs).toBe(firstBuild.mtimeMs);
  });
});

async function createWorkspaceAgent(): Promise<{ appRoot: string; packageRoot: string }> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "eve-workspace-extension-build-")));
  temporaryDirectories.push(appRoot);
  const packageRoot = join(appRoot, "packages", "alpha");
  const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));

  await writeText(join(appRoot, "package.json"), '{"name":"workspace-agent","type":"module"}\n');
  await writeText(join(appRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeText(join(appRoot, "agent", "instructions.md"), "Help Alice plan her week.\n");
  await writeText(
    join(appRoot, "agent", "extensions", "alpha.ts"),
    'export { default } from "../../packages/alpha";\n',
  );
  await writeText(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@acme/alpha",
      type: "module",
      eve: { extension: { source: "extension", dist: "dist/extension" } },
      peerDependencies: { eve: "*" },
    })}\n`,
  );
  await writeText(
    join(packageRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        types: [],
      },
      include: ["extension/**/*.ts"],
    })}\n`,
  );
  await writeText(
    join(packageRoot, "extension", "extension.ts"),
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
  );
  await writeText(
    join(packageRoot, "extension", "tools", "plan_week.ts"),
    'export default { description: "Plan the week.", async execute() { return {}; } };\n',
  );
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await symlink(evePackageRoot, join(packageRoot, "node_modules", "eve"), "dir");

  return { appRoot, packageRoot };
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
