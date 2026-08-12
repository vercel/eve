import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SHA_PATTERN, canaryDependencyUrl, canaryVersion } from "../lib/canary.mjs";

const execFile = promisify(execFileCallback);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const deploymentHost = process.env.VERCEL_URL;

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (!deploymentHost) throw new Error("VERCEL_URL is required to build a canary artifact.");

const originalPackageJson = await readFile(packageJsonPath, "utf8");
const stableVersion = JSON.parse(originalPackageJson).version;
const version = canaryVersion(stableVersion, sourceSha);

try {
  await rm(artifactDirectory, { force: true, recursive: true });
  await execFile(process.execPath, [join(repoRoot, "scripts/prepare-canary-package.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, EVE_CANARY_SHA: sourceSha },
  });
  await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", artifactDirectory], {
    cwd: repoRoot,
    env: {
      ...process.env,
      EVE_CANARY_DEPENDENCY_URL: canaryDependencyUrl(deploymentHost),
    },
  });

  const tarball = await readFile(join(artifactDirectory, `eve-${version}.tgz`));
  const manifest = {
    sourceSha,
    version,
    tarball: canaryDependencyUrl(deploymentHost),
    sha256: createHash("sha256").update(tarball).digest("hex"),
  };

  await mkdir(join(appRoot, "public/canary"), { recursive: true });
  await writeFile(join(appRoot, "public/canary/eve.tgz"), tarball);
  await writeFile(
    join(appRoot, "public/canary/manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(appRoot, "public/index.html"),
    `<!doctype html><title>eve canary</title><pre>${JSON.stringify(manifest, null, 2)}</pre>\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await writeFile(packageJsonPath, originalPackageJson);
  await rm(artifactDirectory, { force: true, recursive: true });
}
