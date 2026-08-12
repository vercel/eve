import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BlobNotFoundError, BlobPreconditionFailedError, head, put } from "@vercel/blob";

import {
  SHA_PATTERN,
  canaryArtifactPath,
  canaryDependencyUrl,
  canaryVersion,
} from "../lib/canary.mjs";

const execFile = promisify(execFileCallback);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const blobStoreId = process.env.BLOB_STORE_ID;

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (!/^store_[0-9A-Za-z]+$/.test(blobStoreId ?? "")) {
  throw new Error("BLOB_STORE_ID must identify the connected public Blob store.");
}

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
      EVE_CANARY_DEPENDENCY_URL: canaryDependencyUrl(blobStoreId, sourceSha, version),
    },
  });

  const tarball = await readFile(join(artifactDirectory, `eve-${version}.tgz`));
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const pathname = canaryArtifactPath(sourceSha, version);
  let artifact;
  try {
    artifact = await put(pathname, tarball, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/gzip",
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    artifact = await head(pathname);
  }

  const manifest = { sourceSha, version, tarball: artifact.url, sha256 };
  await put(`canary/${sourceSha}/manifest.json`, JSON.stringify(manifest), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType: "application/json",
  }).catch((error) => {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
  });
  await advanceLatest(manifest);

  await mkdir(join(appRoot, "public/canary"), { recursive: true });
  await writeFile(join(appRoot, "public/canary/latest"), tarball);
  await writeFile(
    join(appRoot, "public/canary/latest.json"),
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

async function advanceLatest(manifest) {
  let etag;
  try {
    etag = (await head("canary/latest.json")).etag;
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
  }

  try {
    await put("canary/latest.json", JSON.stringify(manifest), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json",
      ...(etag === undefined ? {} : { ifMatch: etag }),
    });
  } catch (error) {
    if (!(error instanceof BlobPreconditionFailedError)) throw error;
  }
}
