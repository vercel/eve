import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildWorkspaceExtensions,
  prepareDevelopmentWorkspaceExtensions,
} from "#internal/nitro/host/workspace-extensions.js";

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

  // https://github.com/vercel/eve/issues/5837
  it("builds an extension after the workspace extension its subagent mounts", async () => {
    const { appRoot, plannerRoot } = await createMountingWorkspaceAgent();

    await buildWorkspaceExtensions(appRoot);

    await expect(
      stat(join(plannerRoot, "dist", "extension", "_manifest.json")),
    ).resolves.toBeDefined();
  });
});

describe("prepareDevelopmentWorkspaceExtensions", () => {
  // https://github.com/vercel/eve/issues/5837
  it("builds an extension after the workspace extension its subagent mounts", async () => {
    const { appRoot, plannerRoot } = await createMountingWorkspaceAgent();

    await prepareDevelopmentWorkspaceExtensions({ appRoot });

    await expect(
      stat(join(plannerRoot, "dist", "extension", "_manifest.json")),
    ).resolves.toBeDefined();
  });
});

/** Adds a `planner` extension whose packaged subagent mounts the `alpha` workspace extension. */
async function createMountingWorkspaceAgent(): Promise<{ appRoot: string; plannerRoot: string }> {
  const { appRoot, packageRoot: alphaRoot } = await createWorkspaceAgent();
  const plannerRoot = await createWorkspaceExtension(appRoot, "planner", {
    dependencies: { "@acme/alpha": "workspace:*" },
  });
  await symlink(alphaRoot, join(plannerRoot, "node_modules", "@acme", "alpha"), "dir");
  await writeText(
    join(plannerRoot, "extension", "subagents", "helper", "agent.ts"),
    [
      'import { defineAgent } from "eve";',
      'export default defineAgent({ description: "Help Bob.", model: "openai/gpt-5.4" });',
      "",
    ].join("\n"),
  );
  await writeText(
    join(plannerRoot, "extension", "subagents", "helper", "extensions", "alpha.ts"),
    'export { default } from "@acme/alpha";\n',
  );
  await writeText(
    join(appRoot, "agent", "extensions", "planner.ts"),
    'export { default } from "../../packages/planner";\n',
  );
  return { appRoot, plannerRoot };
}

async function createWorkspaceAgent(): Promise<{ appRoot: string; packageRoot: string }> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "eve-workspace-extension-build-")));
  temporaryDirectories.push(appRoot);

  await writeText(join(appRoot, "package.json"), '{"name":"workspace-agent","type":"module"}\n');
  await writeText(join(appRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeText(join(appRoot, "agent", "instructions.md"), "Help Alice plan her week.\n");
  await writeText(
    join(appRoot, "agent", "extensions", "alpha.ts"),
    'export { default } from "../../packages/alpha";\n',
  );
  const packageRoot = await createWorkspaceExtension(appRoot, "alpha");
  await writeText(
    join(packageRoot, "extension", "tools", "plan_week.ts"),
    'export default { description: "Plan the week.", async execute() { return {}; } };\n',
  );

  return { appRoot, packageRoot };
}

async function createWorkspaceExtension(
  appRoot: string,
  name: string,
  packageFields: Record<string, unknown> = {},
): Promise<string> {
  const packageRoot = join(appRoot, "packages", name);
  const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  await writeText(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: `@acme/${name}`,
      type: "module",
      eve: { extension: { source: "extension", dist: "dist/extension" } },
      peerDependencies: { eve: "*" },
      ...packageFields,
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
  await mkdir(join(packageRoot, "node_modules", "@acme"), { recursive: true });
  await symlink(evePackageRoot, join(packageRoot, "node_modules", "eve"), "dir");

  return packageRoot;
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
