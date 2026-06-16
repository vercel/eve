import { createSitemapMarkdownRoute } from "@vercel/geistdocs/routes/sitemap";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const revalidate = false;
export const dynamic = "error";

const sitemapRoute = createSitemapMarkdownRoute({
  config,
  sources: [{ source: geistdocsSource }],
});

export const GET = sitemapRoute.GET;
export const generateStaticParams = sitemapRoute.generateStaticParams;
