import { list } from "@vercel/blob";

export default async function handler(request, response) {
  const sha = request.query.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    return response.status(400).send("Invalid canary SHA.\n");
  }
  const result = await list({ prefix: `canary/${sha}/eve-`, limit: 1 });
  const artifact = result.blobs[0];
  if (artifact === undefined) return response.status(404).send("Canary not found.\n");
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return response.redirect(302, artifact.url);
}
