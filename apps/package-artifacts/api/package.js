import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { get } from "@vercel/blob";

import { SHA_PATTERN, packageArtifactPath, packageManifestPath } from "../lib/package.mjs";

export default async function handler(request, response) {
  const ref = request.query.ref;
  if (typeof ref !== "string" || (ref !== "main" && !SHA_PATTERN.test(ref))) {
    return packageNotFound(response);
  }

  // Resolve `main` to the commit represented by the current production deployment.
  const sourceSha = ref === "main" ? process.env.VERCEL_GIT_COMMIT_SHA : ref;
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    return packageNotFound(response);
  }

  const manifest = await resolveManifest(sourceSha);
  if (manifest === undefined) return packageNotFound(response);

  if (request.query.manifest === "1") {
    if (ref !== "main") return packageNotFound(response);
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.status(200).json(manifest);
  }
  if (ref === "main") {
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.redirect(302, manifest.tarball);
  }

  const artifact = await get(packageArtifactPath(sourceSha), { access: "private" });
  if (artifact === null) return packageNotFound(response);

  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Content-Type", "application/gzip");
  await pipeline(Readable.fromWeb(artifact.stream), response);
  return undefined;
}

function packageNotFound(response) {
  return response.status(404).send("Package not found.\n");
}

async function resolveManifest(sourceSha) {
  const result = await get(packageManifestPath(sourceSha), { access: "private" });
  if (result === null) return undefined;

  const manifest = JSON.parse(await new Response(result.stream).text());
  if (
    manifest.sourceSha !== sourceSha ||
    typeof manifest.version !== "string" ||
    typeof manifest.tarball !== "string" ||
    typeof manifest.sha256 !== "string"
  ) {
    return undefined;
  }
  return manifest;
}
