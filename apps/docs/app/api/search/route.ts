import { createSearchRoute } from "@vercel/geistdocs/routes/search";
import { analyticsEvents, getCountBucket, normalizeSearchQuery } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

const search = createSearchRoute({
  config,
  sources: [geistdocsSource, integrationSource],
});

export const GET = async (request: Request): Promise<Response> => {
  const response = await search(request);
  const query = normalizeSearchQuery(new URL(request.url).searchParams.get("query") ?? "");

  if (query) {
    let resultCount = 0;
    try {
      const body: unknown = await response.clone().json();
      if (Array.isArray(body)) resultCount = body.length;
    } catch {
      // Preserve the search response if a future geistdocs version changes its payload.
    }

    trackServerEvent(request, analyticsEvents.docsSearched, {
      query,
      results: getCountBucket(resultCount),
    });
  }

  return response;
};
