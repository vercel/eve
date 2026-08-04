import { getPublicPath } from "@vercel/geistdocs/config";
import type { MetadataRoute } from "next";
import { canonicalRoutes, integrationPath, templatePath } from "@/lib/geistdocs/canonical";
import { config } from "@/lib/geistdocs/config";
import { defaultLanguage } from "@/lib/geistdocs/languages";
import {
  compatibilityRedirects,
  defaultLanguageRedirects,
  docsRedirects,
  rootMarkdownRedirects,
} from "@/lib/geistdocs/redirects";
import { createCanonicalSitemap, type SitemapSourceEntry } from "@/lib/geistdocs/sitemap";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { integrations } from "@/lib/integrations/data";
import { templateEntries } from "@/lib/templates/data";

const getLastModified = (data: unknown): Date | undefined => {
  if (!data || typeof data !== "object" || !("lastModified" in data)) return;
  return data.lastModified instanceof Date ? data.lastModified : undefined;
};

const redirectPathnames = [
  "/docs",
  ...compatibilityRedirects.map(({ source }) => source),
  ...docsRedirects.map(({ source }) => source),
  ...rootMarkdownRedirects.map(({ source }) => source),
  ...defaultLanguageRedirects.map(({ source }) => source),
].filter((pathname) => !pathname.includes(":"));

export default function sitemap(): MetadataRoute.Sitemap {
  const docs: SitemapSourceEntry[] = geistdocsSource.source
    .getPages(defaultLanguage)
    .map((page) => ({
      pathname: getPublicPath(page.url, config.basePath),
      lastModified: getLastModified(page.data),
    }));

  return createCanonicalSitemap({
    excludedPathnames: redirectPathnames,
    origin: getSiteOrigin(),
    sources: [
      { pathname: canonicalRoutes.home },
      ...docs,
      { pathname: canonicalRoutes.integrations },
      ...integrations.map(({ slug }) => ({ pathname: integrationPath(slug) })),
      { pathname: canonicalRoutes.templates },
      ...templateEntries.map(({ slug }) => ({ pathname: templatePath(slug) })),
    ],
  });
}
