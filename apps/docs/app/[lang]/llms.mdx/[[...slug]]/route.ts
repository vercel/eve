import { createDocsMarkdownRoute } from "@vercel/geistdocs/routes/llms";
import { getMarkdownRequestedPath } from "@/lib/geistdocs/markdown-path";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

export const revalidate = false;

const markdownRoute = createDocsMarkdownRoute({
  notFound: { getRequestedPath: getMarkdownRequestedPath },
  sources: [geistdocsSource, integrationSource],
});

export const GET = markdownRoute.GET;
export const generateStaticParams = markdownRoute.generateStaticParams;
