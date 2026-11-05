import { createSearchRoute } from "@vercel/geistdocs/routes/search";
import type { SortedResult } from "fumadocs-core/search";
import { config } from "@/lib/geistdocs/config";
import { rankTitleMatches } from "@/lib/geistdocs/search-ranking";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

const search = createSearchRoute({
  config,
  sources: [geistdocsSource, integrationSource],
});

export async function GET(request: Request): Promise<Response> {
  const response = await search(request);
  const query = new URL(request.url).searchParams.get("query");
  if (!response.ok || !query) return response;

  const results = (await response.json()) as SortedResult[];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(rankTitleMatches(results, query), { headers, status: response.status });
}
