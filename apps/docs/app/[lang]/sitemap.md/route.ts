import { createSitemapMarkdownRoute } from "@vercel/geistdocs/routes/sitemap";
import { config } from "@/lib/geistdocs/config";
import { resolveDocsPageTitle } from "@/lib/geistdocs/page-title";
import { transformSitemapMarkdown } from "@/lib/geistdocs/sitemap-transform";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";
import { templateManifest } from "@/lib/templates/manifest";

export const revalidate = false;
export const dynamic = "error";

const sitemapRoute = createSitemapMarkdownRoute({
  config,
  sources: [{ source: geistdocsSource }, { source: integrationSource }],
  transform: (markdown, { lang }) =>
    transformSitemapMarkdown(markdown, {
      resolveTitle: (title, url) =>
        resolveDocsPageTitle({
          pageTitle: title,
          pageUrl: url,
          tree: geistdocsSource.source.getPageTree(lang),
        }) ?? title,
      templates: templateManifest,
    }),
});

export const GET = sitemapRoute.GET;
export const generateStaticParams = sitemapRoute.generateStaticParams;
