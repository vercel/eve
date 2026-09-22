import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, it } from "vitest";

import { renderSelfModificationConfig } from "./setup.js";

const runFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stderr: string; stdout: string }> {
  try {
    return await runFile(command, args, {
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
    await access(join(packageRoot, "dist/src/index.js"));
    await access(join(packageRoot, "dist/src/self-modification/agent.js"));
    await access(join(packageRoot, "dist/src/self-modification/config.js"));
    await access(join(packageRoot, "dist/src/self-modification/sandbox.js"));
    await access(join(packageRoot, "dist/src/self-modification/setup.js"));
    await access(
      join(packageRoot, "dist/src/self-modification/extension/subagents/agent/tools/edit_file.js"),
    );

    const root = await mkdtemp(join(tmpdir(), "eve-self-modification-package-"));
    temporaryRoots.push(root);
    const tarballsRoot = join(root, "tarballs");
    const appRoot = join(root, "app");
    await mkdir(tarballsRoot, { recursive: true });
    await mkdir(appRoot, { recursive: true });

    const eveTarball = await pack(packageRoot, tarballsRoot, "eve");
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
            "@vercel/connect": "2.2.0",
            eve: `file:${eveTarball}`,
            "just-bash": "3.1.0",
            microsandbox: "0.5.5",
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
      "agent/extensions/self-modification/extension.ts",
      renderSelfModificationConfig({
        branch: "main",
        channelNames: [],
        connector: "github/selfmod-acme-agent",
        directory: ".",
        repository: "github.com/acme/agent",
        vercelBackend: true,
      }),
    );

    await run(
      "pnpm",
      ["install", "--ignore-scripts", "--no-frozen-lockfile", "--prefer-offline"],
      appRoot,
    );
    await access(join(appRoot, "node_modules/eve/dist/src/self-modification/agent.js"));
    await writeAppFile(
      appRoot,
      "verify-development-extension.mjs",
      `import { defaultDevelopmentExtensions } from "./node_modules/eve/dist/src/compiler/development-extensions.js";
import { compileAgentManifest } from "./node_modules/eve/dist/src/compiler/normalize-manifest.js";
import { createAgentSourceManifest } from "./node_modules/eve/dist/src/discover/manifest.js";

const manifest = createAgentSourceManifest({ agentId: "packed-dev", agentRoot: "/virtual/agent", appRoot: "/virtual" });
const compiled = await compileAgentManifest(manifest, { developmentExtensions: defaultDevelopmentExtensions() });
const subagent = compiled.subagents.find((entry) => entry.name === "self-modification__agent");
if (compiled.subagents.length !== 1 || subagent === undefined || !subagent.agent.tools.some((tool) => tool.name === "edit_file")) {
  throw new Error("Packed eve did not discover the bundled self-modification extension.");
}
`,
    );
    await run("node", ["verify-development-extension.mjs"], appRoot);
    const build = await run("pnpm", ["build"], appRoot);
    const output = `${build.stdout}\n${build.stderr}`;
    if (output.includes("Could not resolve '#shared/")) {
      throw new Error(
        `Packed eve leaked a package-private import into the application build:\n${output}`,
      );
    }
  }, 120_000);
});
