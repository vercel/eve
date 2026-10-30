import { createSearchRoute } from "@vercel/geistdocs/routes/search";
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

  const results: unknown = await response.json();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const body = Array.isArray(results) ? rankTitleMatches(results, query) : results;
  return Response.json(body, { headers, status: response.status });
}
