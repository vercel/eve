import { createDocsMarkdownRoute } from "@vercel/geistdocs/routes/llms";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const revalidate = false;

const markdownRoute = createDocsMarkdownRoute({
  source: geistdocsSource,
});

export const GET = markdownRoute.GET;
export const generateStaticParams = markdownRoute.generateStaticParams;
