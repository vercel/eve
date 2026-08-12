import { get } from "@vercel/blob";

import { SHA_PATTERN, packageManifestPath } from "../lib/package.mjs";

export default async function handler(request, response) {
  const ref = request.query.ref;
  if (typeof ref !== "string" || (ref !== "main" && !SHA_PATTERN.test(ref))) {
    return response.status(404).send("Package not found.\n");
  }

  // The production deployment itself is the moving main pointer; Blob stores only SHA data.
  const sourceSha = ref === "main" ? process.env.VERCEL_GIT_COMMIT_SHA : ref;
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    return response.status(404).send("Package not found.\n");
  }

  const manifest = await resolveManifest(sourceSha);
  if (manifest === undefined) return response.status(404).send("Package not found.\n");

  response.setHeader(
    "Cache-Control",
    ref === "main" ? "public, max-age=60" : "public, max-age=31536000, immutable",
  );
  if (request.query.manifest === "1") {
    if (ref !== "main") return response.status(404).send("Package not found.\n");
    return response.status(200).json(manifest);
  }
  return response.redirect(302, manifest.tarball);
}

async function resolveManifest(sourceSha) {
  const result = await get(packageManifestPath(sourceSha), { access: "public", useCache: false });
  if (result === null) return undefined;

  const manifest = JSON.parse(await new Response(result.stream).text());
  return manifest.sourceSha === sourceSha &&
    typeof manifest.version === "string" &&
    typeof manifest.tarball === "string" &&
    typeof manifest.sha256 === "string"
    ? manifest
    : undefined;
}
