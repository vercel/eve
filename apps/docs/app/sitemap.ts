import type { MetadataRoute } from "next";

import { source } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";

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
      url: url("/resources"),
    },
    ...pages,
  ];
}
