import type { MetadataRoute } from "next";

import { source } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { integrations } from "@/lib/integrations/data";

const baseUrl = getSiteOrigin();

export const revalidate = false;

const getLastModified = (data: object) =>
  "lastModified" in data && data.lastModified instanceof Date ? data.lastModified : undefined;

export default function sitemap(): MetadataRoute.Sitemap {
  const url = (path: string): string => new URL(path, baseUrl).toString();

  const pages: MetadataRoute.Sitemap = [];

  for (const page of source.getPages()) {
    const lastModified = getLastModified(page.data);

    pages.push({
      changeFrequency: "weekly" as const,
      lastModified,
      priority: 0.5,
      url: url(page.url),
    });
  }

  const integrationPages: MetadataRoute.Sitemap = integrations.map((integration) => ({
    changeFrequency: "weekly" as const,
    priority: integration.source === "generated" ? 0.3 : 0.6,
    url: url(`/integrations/${integration.slug}`),
  }));

  return [
    {
      changeFrequency: "monthly",
      priority: 1,
      url: url("/"),
    },
    {
      changeFrequency: "weekly",
      priority: 0.5,
      url: url("/resources"),
    },
    {
      changeFrequency: "weekly",
      priority: 0.8,
      url: url("/integrations"),
    },
    ...pages,
    ...integrationPages,
  ];
}
