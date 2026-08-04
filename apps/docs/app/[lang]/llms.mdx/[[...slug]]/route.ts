import { createDocsMarkdownRoute } from "@vercel/geistdocs/routes/llms";
import {
  analyticsEvents,
  countMarkdownSuggestions,
  getCountBucket,
  getDocsSurface,
  getMarkdownFormat,
} from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getMarkdownRequestedPath } from "@/lib/geistdocs/markdown-path";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

export const revalidate = false;

const markdownRoute = createDocsMarkdownRoute({
  notFound: { getRequestedPath: getMarkdownRequestedPath },
  sources: [geistdocsSource, integrationSource],
});

export const GET = async (request: Request, context: Parameters<typeof markdownRoute.GET>[1]) => {
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

  return response;
};
export const generateStaticParams = markdownRoute.generateStaticParams;
