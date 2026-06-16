import { Feed } from "feed";
import type { NextRequest } from "next/server";
import { title } from "@/geistdocs";
import { source } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";

const baseUrl = getSiteOrigin();

export const revalidate = false;

const getLastModified = (data: object) =>
  "lastModified" in data && data.lastModified instanceof Date ? data.lastModified : undefined;

export const GET = async (_req: NextRequest, { params }: RouteContext<"/[lang]/rss.xml">) => {
  const { lang } = await params;
  const feed = new Feed({
    title,
    id: baseUrl,
    link: baseUrl,
    language: lang,
    copyright: `All rights reserved ${new Date().getFullYear()}, Vercel`,
  });

  for (const page of source.getPages(lang)) {
    const lastModified = getLastModified(page.data);

    feed.addItem({
      id: page.url,
      title: page.data.title ?? page.url,
      description: page.data.description,
      link: `${baseUrl}${page.url}`,
      date: lastModified ?? new Date(),
      author: [
        {
          name: "Vercel",
        },
      ],
    });
  }

  const rss = feed.rss2();

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml",
    },
  });
};
