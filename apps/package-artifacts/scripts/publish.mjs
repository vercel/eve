import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { get, put } from "@vercel/blob";

import {
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  packageArtifactPath,
  packageManifestPath,
  packagePointerPath,
} from "../lib/package.mjs";

const inputDirectory = resolve(process.env.EVE_PACKAGE_INPUT_DIRECTORY ?? "package-artifact");
const expectedSha = process.env.EVE_PACKAGE_SOURCE_SHA;
const expectedRef = process.env.EVE_PACKAGE_REF;
const token = process.env.EVE_PACKAGE_BLOB_READ_WRITE_TOKEN;

if (!SHA_PATTERN.test(expectedSha ?? "")) {
  throw new Error("EVE_PACKAGE_SOURCE_SHA must be a 40-character Git commit SHA.");
}
if (expectedRef !== "main" && !PULL_REQUEST_PATTERN.test(expectedRef ?? "")) {
  throw new Error("EVE_PACKAGE_REF must be main or a positive pull request number.");
}
if (typeof token !== "string" || token.length === 0) {
  throw new Error("EVE_PACKAGE_BLOB_READ_WRITE_TOKEN is required.");
}

const tarball = await readFile(join(inputDirectory, "eve.tgz"));
const metadata = JSON.parse(await readFile(join(inputDirectory, "metadata.json"), "utf8"));
const sha256 = createHash("sha256").update(tarball).digest("hex");
if (
  metadata.sourceSha !== expectedSha ||
  metadata.ref !== expectedRef ||
  metadata.sha256 !== sha256 ||
  !/^\d+\.\d+\.\d+\+git\.[0-9a-f]{40}$/i.test(metadata.version ?? "") ||
  !metadata.version.endsWith(`+git.${expectedSha}`) ||
  typeof metadata.tarball !== "string"
) {
  throw new Error("Package artifact metadata does not match the trusted publication target.");
}
const expectedUrl = `https://pkg.eve.dev/${expectedSha}/eve.tgz`;
if (metadata.tarball !== expectedUrl) {
  throw new Error(`Package artifact URL must be ${expectedUrl}.`);
}

const manifest = {
  sourceSha: expectedSha,
  version: metadata.version,
  tarball: expectedUrl,
  sha256,
};
await putImmutableArtifact(packageArtifactPath(expectedSha), tarball, sha256);
await putImmutableManifest(packageManifestPath(expectedSha), manifest);
await put(packagePointerPath(expectedRef), JSON.stringify(manifest), {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  cacheControlMaxAge: 60,
  contentType: "application/json",
  token,
});
process.stdout.write(`${JSON.stringify(manifest)}\n`);

async function putImmutableArtifact(pathname, bytes, expectedHash) {
  try {
    await put(pathname, bytes, immutableOptions("application/gzip"));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, { access: "private", useCache: false, token });
    if (published === null) throw new Error("Published package artifact could not be read.");
    const publishedHash = createHash("sha256")
      .update(Buffer.from(await new Response(published.stream).arrayBuffer()))
      .digest("hex");
    if (publishedHash !== expectedHash) {
      throw new Error(
        `Commit ${expectedSha} was already published with different package contents.`,
      );
    }
  }
}

async function putImmutableManifest(pathname, value) {
  try {
    await put(pathname, JSON.stringify(value), immutableOptions("application/json"));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, { access: "private", useCache: false, token });
    if (published === null) throw new Error("Published package manifest could not be read.");
    if (JSON.parse(await new Response(published.stream).text()).sha256 !== value.sha256) {
      throw new Error(
        `Commit ${expectedSha} was already published with different package contents.`,
      );
    }
  }
}

function immutableOptions(contentType) {
  return {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType,
    token,
  };
}
