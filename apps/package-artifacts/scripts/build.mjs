import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { get, head, put } from "@vercel/blob";

import {
  SHA_PATTERN,
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  preparePackageJson,
} from "../lib/package.mjs";

const execFile = promisify(execFileCallback);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const branch = process.env.VERCEL_GIT_COMMIT_REF;

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (branch !== "main" || process.env.VERCEL_ENV !== "production") {
  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public/index.html"),
    "<!doctype html><title>eve packages</title><p>Artifacts are only published from main.</p>\n",
  );
  process.exit(0);
}

const originalPackageJson = await readFile(packageJsonPath, "utf8");
const preparedPackageJson = preparePackageJson(JSON.parse(originalPackageJson), sourceSha);
const version = preparedPackageJson.version;
const dependencyUrl = packageDependencyUrl(sourceSha);
const artifactPath = packageArtifactPath(sourceSha, version);

try {
  await rm(artifactDirectory, { force: true, recursive: true });
  await writeFile(packageJsonPath, `${JSON.stringify(preparedPackageJson, null, 2)}\n`);
  await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", artifactDirectory], {
    cwd: repoRoot,
    env: { ...process.env, EVE_MAIN_DEPENDENCY_URL: dependencyUrl },
  });

  const tarball = await readFile(join(artifactDirectory, `eve-${version}.tgz`));
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  let artifact;
  try {
    artifact = await put(artifactPath, tarball, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/gzip",
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    artifact = await head(artifactPath);
    const publishedTarball = await fetch(artifact.url);
    if (!publishedTarball.ok) {
      throw new Error(`Published package artifact returned ${publishedTarball.status}.`);
    }
    const publishedSha256 = createHash("sha256")
      .update(Buffer.from(await publishedTarball.arrayBuffer()))
      .digest("hex");
    if (publishedSha256 !== sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }

  const manifest = { sourceSha, version, tarball: artifact.url, sha256 };
  const manifestPath = packageManifestPath(sourceSha);
  const existingManifest = await get(manifestPath, { access: "public", useCache: false });
  if (existingManifest === null) {
    await put(manifestPath, JSON.stringify(manifest), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/json",
    });
  } else {
    const published = JSON.parse(await new Response(existingManifest.stream).text());
    if (published.sha256 !== sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }

  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public/index.html"),
    `<!doctype html><title>eve packages</title><pre>${JSON.stringify(manifest, null, 2)}</pre>\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await writeFile(packageJsonPath, originalPackageJson);
  await rm(artifactDirectory, { force: true, recursive: true });
}
