import { get } from "@vercel/blob";

export default async function handler(_request, response) {
  const result = await get("canary/latest.json", { access: "public", useCache: false });
  if (result === null) return response.status(404).json({ error: "No canary has been published." });
  const manifest = JSON.parse(await new Response(result.stream).text());
  response.setHeader("Cache-Control", "public, max-age=60");
  return response.status(200).json(manifest);
}
