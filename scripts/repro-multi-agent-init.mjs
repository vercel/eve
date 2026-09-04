#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evePackageRoot = join(repositoryRoot, "packages", "eve");
const projectName = process.argv[2] ?? "my-project";

if (process.argv.length > 3 || projectName.startsWith("-")) {
  console.error("Usage: node scripts/repro-multi-agent-init.mjs [project-name]");
  process.exitCode = 1;
} else {
  const packageJson = JSON.parse(await readFile(join(evePackageRoot, "package.json"), "utf8"));
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== "string")
    throw new Error("packages/eve/package.json has no version.");

  const tempRoot = await mkdtemp(join(tmpdir(), "eve-multi-agent-init-"));
  const packDirectory = await mkdtemp(join(tmpdir(), "eve-multi-agent-pack-"));
  const homeDirectory = await mkdtemp(join(tmpdir(), "eve-multi-agent-home-"));
  const target = join(tempRoot, projectName);
  await writeFile(join(homeDirectory, ".npmrc"), "registry=https://registry.npmjs.org/\n");

  try {
    await run("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: evePackageRoot });
    const environment = {
      ...process.env,
      EVE_INIT_PACKAGE_SPEC: `file:${join(packDirectory, `eve-${packageVersion}.tgz`)}`,
      HOME: homeDirectory,
      npm_config_globalconfig: "/dev/null",
      npm_config_registry: "https://registry.npmjs.org",
      npm_config_userconfig: join(homeDirectory, ".npmrc"),
    };
    await run(
      process.execPath,
      [join(evePackageRoot, "bin", "eve.js"), "init", target, "--agents", "researcher,bug-finder"],
      {
        cwd: tempRoot,
        env: environment,
      },
    );
    console.log(`\nCreated test workspace: ${target}`);
  } finally {
    await Promise.all([
      rm(packDirectory, { force: true, recursive: true }),
      rm(homeDirectory, { force: true, recursive: true }),
    ]);
  }
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}
