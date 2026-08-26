import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, it } from "vitest";

const runFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evePackageRoot = resolve(packageRoot, "../eve");
const temporaryRoots: string[] = [];

async function run(command: string, args: string[], cwd: string): Promise<void> {
  try {
    await runFile(command, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (error) {
    const failure = error as { stderr?: unknown; stdout?: unknown };
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `cwd: ${cwd}`,
        `stdout:\n${typeof failure.stdout === "string" ? failure.stdout : ""}`,
        `stderr:\n${typeof failure.stderr === "string" ? failure.stderr : ""}`,
      ].join("\n\n"),
      { cause: error },
    );
  }
}

async function pack(
  packageDirectory: string,
  destination: string,
  prefix: string,
): Promise<string> {
  await run(
    "pnpm",
    ["pack", "--config.ignore-scripts=true", "--pack-destination", destination],
    packageDirectory,
  );
  const tarball = (await readdir(destination)).find(
    (entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".tgz"),
  );

  if (tarball === undefined) {
    throw new Error(`Expected a ${prefix}-*.tgz tarball in ${destination}.`);
  }
  return join(destination, tarball);
}

async function writeAppFile(
  appRoot: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const path = join(appRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

describe("packed package consumption", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("builds a fresh app using only installed tarball contents", async () => {
    await access(join(packageRoot, "dist/index.mjs"));
    await access(join(packageRoot, "scaffold/agent.js"));
    await access(join(evePackageRoot, "dist/src/index.js"));

    const root = await mkdtemp(join(tmpdir(), "eve-self-modification-package-"));
    temporaryRoots.push(root);
    const tarballsRoot = join(root, "tarballs");
    const appRoot = join(root, "app");
    await mkdir(tarballsRoot, { recursive: true });
    await mkdir(appRoot, { recursive: true });

    const eveTarball = await pack(evePackageRoot, tarballsRoot, "eve");
    const selfModificationTarball = await pack(packageRoot, tarballsRoot, "eve-self-modification");
    await writeAppFile(
      appRoot,
      "package.json",
      `${JSON.stringify(
        {
          name: "packed-self-modification-app",
          private: true,
          type: "module",
          scripts: { build: "eve build" },
          dependencies: {
            "@eve/self-modification": `file:${selfModificationTarball}`,
            eve: `file:${eveTarball}`,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeAppFile(
      appRoot,
      "pnpm-workspace.yaml",
      `overrides:\n  eve: ${JSON.stringify(`file:${eveTarball}`)}\n`,
    );
    await writeAppFile(
      appRoot,
      "agent/agent.ts",
      'import { defineAgent } from "eve";\n\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeAppFile(appRoot, "agent/instructions.md", "You are a test agent.\n");
    await writeAppFile(
      appRoot,
      "agent/subagents/self-modification/agent.ts",
      'import { defineSelfModificationAgent } from "@eve/self-modification/agent";\n\nexport default defineSelfModificationAgent();\n',
    );
    await writeAppFile(
      appRoot,
      "agent/subagents/self-modification/sandbox.ts",
      'export { default } from "@eve/self-modification/sandbox";\n',
    );
    await writeAppFile(
      appRoot,
      "agent/subagents/self-modification/extensions/selfmod.ts",
      'export { default } from "@eve/self-modification";\n',
    );

    await run(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--prefer-offline",
        "--config.minimum-release-age=0",
      ],
      appRoot,
    );
    await access(join(appRoot, "node_modules/@eve/self-modification/src/agent.ts"));
    await run("pnpm", ["build"], appRoot);
  }, 120_000);
});
