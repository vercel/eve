import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { get } from "@vercel/blob";

import {
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  packageArtifactPath,
  packageManifestPath,
  packagePointerPath,
} from "../lib/package.mjs";

export default async function handler(request, response) {
  const ref = request.query.ref;
  if (ref === "main" || (typeof ref === "string" && PULL_REQUEST_PATTERN.test(ref))) {
    return servePointer(ref, request, response);
  }
  if (typeof ref !== "string" || !SHA_PATTERN.test(ref)) return packageNotFound(response);

  const manifest = await resolveManifest(ref);
  if (manifest === undefined) return packageNotFound(response);
  if (request.query.manifest === "1") return packageNotFound(response);

  const artifact = await get(packageArtifactPath(ref), { access: "private" });
  if (artifact === null) return packageNotFound(response);
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Content-Type", "application/gzip");
  await pipeline(Readable.fromWeb(artifact.stream), response);
  return undefined;
}

async function servePointer(ref, request, response) {
  const result = await get(packagePointerPath(ref), { access: "private" });
  if (result === null) return packageNotFound(response);
  const manifest = parseManifest(await new Response(result.stream).text());
  if (manifest === undefined) return packageNotFound(response);

  response.setHeader("Cache-Control", "public, max-age=60");
  if (request.query.manifest === "1") return response.status(200).json(manifest);
  return response.redirect(302, manifest.tarball);
}

function packageNotFound(response) {
  return response.status(404).send("Package not found.\n");
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
    !SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    (expectedSha !== undefined && manifest.sourceSha !== expectedSha) ||
    typeof manifest.version !== "string" ||
    manifest.tarball !== `https://pkg.eve.dev/${manifest.sourceSha}/eve.tgz` ||
    !/^[0-9a-f]{64}$/i.test(manifest.sha256 ?? "")
  ) {
    return undefined;
  }
  return manifest;
}
