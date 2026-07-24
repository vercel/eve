import { createSitemapMarkdownRoute } from "@vercel/geistdocs/routes/sitemap";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

export const revalidate = false;
export const dynamic = "error";

const sitemapRoute = createSitemapMarkdownRoute({
  config,
  sources: [{ source: geistdocsSource }, { source: integrationSource }],
});

export const GET = sitemapRoute.GET;
export const generateStaticParams = sitemapRoute.generateStaticParams;
