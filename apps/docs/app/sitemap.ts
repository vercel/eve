import type { MetadataRoute } from "next";

import { source } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { templateEntries } from "@/lib/templates/data";

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

  return [
    {
      changeFrequency: "monthly",
      priority: 1,
      url: url("/"),
    },
    {
      changeFrequency: "weekly",
      priority: 0.5,
      url: url("/templates"),
    },
    ...templateEntries.map((entry) => ({
      changeFrequency: "weekly" as const,
      priority: 0.4,
      url: url(`/templates/${entry.slug}`),
    })),
    ...pages,
  ];
}
