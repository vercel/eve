import { get } from "@vercel/blob";

export default async function handler(_request, response) {
  const result = await get("canary/latest.json", { access: "public", useCache: false });
  if (result === null) return response.status(404).send("No canary has been published.\n");
  const manifest = JSON.parse(await new Response(result.stream).text());
  response.setHeader("Cache-Control", "public, max-age=60");
  return response.redirect(302, manifest.tarball);
}
