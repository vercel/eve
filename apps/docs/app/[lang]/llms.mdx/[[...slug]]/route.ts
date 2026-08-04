import { createDocsMarkdownRoute } from "@vercel/geistdocs/routes/llms";
import {
  analyticsEvents,
  countMarkdownSuggestions,
  getCountBucket,
  getDocsSurface,
  getMarkdownFormat,
} from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { applyMarkdownRouteCanonical } from "@/lib/geistdocs/markdown-canonical";
import { getMarkdownRequestedPath } from "@/lib/geistdocs/markdown-path";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { integrationSource } from "@/lib/integrations/source";

export const revalidate = false;

const markdownRoute = createDocsMarkdownRoute({
  notFound: { getRequestedPath: getMarkdownRequestedPath },
  sources: [geistdocsSource, integrationSource],
});

export const GET: typeof markdownRoute.GET = async (request, context) => {
  const response = await markdownRoute.GET(request, context);

  if (response.headers.get("x-geistdocs-not-found") === "1") {
    const { pathname } = new URL(request.url);
    const body = await response.clone().text();
    trackServerEvent(request, analyticsEvents.smartMarkdownNotFound, {
      format: getMarkdownFormat(pathname, request.headers.get("accept")),
      suggestions: getCountBucket(countMarkdownSuggestions(body)),
      surface: getDocsSurface(pathname),
    });
  }

  const { slug = [] } = await context.params;
  const canonicalUrl = `${getSiteOrigin()}${getMarkdownRequestedPath({ slug })}`;

  return applyMarkdownRouteCanonical(response, canonicalUrl);
};
export const generateStaticParams = markdownRoute.generateStaticParams;
