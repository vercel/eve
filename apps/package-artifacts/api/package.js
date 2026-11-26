import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { get } from "@vercel/blob";

import {
  PACKAGE_SLUG_PATTERN,
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  manifestPackages,
  packageArtifactPath,
  packageManifestPath,
  packagePointerPath,
  packageSlug,
} from "../lib/package.mjs";

export default async function handler(request, response) {
  const { ref, package: slug = "eve" } = request.query;
  if (typeof slug !== "string" || !PACKAGE_SLUG_PATTERN.test(slug)) {
    return packageNotFound(response);
  }
  if (ref === "main" || (typeof ref === "string" && PULL_REQUEST_PATTERN.test(ref))) {
    return servePointer(ref, slug, request, response);
  }
  if (typeof ref !== "string" || !SHA_PATTERN.test(ref)) return packageNotFound(response);

  const manifest = await resolveManifest(ref);
  if (manifest === undefined || findPackage(manifest, slug) === undefined) {
    return packageNotFound(response);
  }
  if (request.query.manifest === "1") return packageNotFound(response);

  const artifact = await get(packageArtifactPath(ref, slug), { access: "private" });
  if (artifact === null) return packageNotFound(response);
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Content-Type", "application/gzip");
  await pipeline(Readable.fromWeb(artifact.stream), response);
  return undefined;
}

async function servePointer(ref, slug, request, response) {
  const result = await get(packagePointerPath(ref), { access: "private" });
  if (result === null) return packageNotFound(response);
  const manifest = parseManifest(await new Response(result.stream).text());
  if (manifest === undefined) return packageNotFound(response);

  if (request.query.manifest === "1") {
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.status(200).json(manifest);
  }
  const entry = findPackage(manifest, slug);
  if (entry === undefined) return packageNotFound(response);
  response.setHeader("Cache-Control", "public, max-age=60");
  return response.redirect(302, entry.tarball);
}

function packageNotFound(response) {
  return response.status(404).send("Package not found.\n");
}

function findPackage(manifest, slug) {
  return Object.entries(manifestPackages(manifest)).find(
    ([name]) => packageSlug(name) === slug,
  )?.[1];
}

async function resolveManifest(sourceSha) {
  const result = await get(packageManifestPath(sourceSha), { access: "private" });
  if (result === null) return undefined;
  return parseManifest(await new Response(result.stream).text(), sourceSha);
}

function parseManifest(source, expectedSha) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (
    !SHA_PATTERN.test(manifest?.sourceSha ?? "") ||
    (expectedSha !== undefined && manifest.sourceSha !== expectedSha)
  ) {
    return undefined;
  }
  const valid = Object.entries(manifestPackages(manifest)).every(([name, entry]) =>
    isValidPackage(name, entry, manifest.sourceSha),
  );
  return valid ? manifest : undefined;
}

function isValidPackage(name, entry, sourceSha) {
  try {
    return (
      typeof entry?.version === "string" &&
      entry.tarball === `https://pkg.eve.dev/${sourceSha}/${packageSlug(name)}.tgz` &&
      /^[0-9a-f]{64}$/i.test(entry.sha256 ?? "")
    );
  } catch {
    return false;
  }
}
