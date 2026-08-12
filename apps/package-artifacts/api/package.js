import { get, list } from "@vercel/blob";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export default async function handler(request, response) {
  const ref = request.query.ref;
  if (typeof ref !== "string" || ref.length === 0) {
    return response.status(400).send("A branch or commit SHA is required.\n");
  }

  const manifest = SHA_PATTERN.test(ref) ? await resolveSha(ref) : await resolveBranch(ref);
  if (manifest === undefined) return response.status(404).send("Package not found.\n");

  response.setHeader("Cache-Control", "public, max-age=60");
  if (request.query.manifest === "1") return response.status(200).json(manifest);
  return response.redirect(302, manifest.tarball);
}

async function resolveSha(sourceSha) {
  const result = await list({ prefix: `packages/${sourceSha}/eve-`, limit: 1 });
  const artifact = result.blobs[0];
  if (artifact === undefined) return undefined;
  return { sourceSha, tarball: artifact.url };
}

async function resolveBranch(branch) {
  const result = await get(`branches/${encodeURIComponent(branch)}.json`, {
    access: "public",
    useCache: false,
  });
  if (result === null) return undefined;
  const manifest = JSON.parse(await new Response(result.stream).text());
  return typeof manifest.sourceSha === "string" &&
    SHA_PATTERN.test(manifest.sourceSha) &&
    typeof manifest.tarball === "string"
    ? manifest
    : undefined;
}
